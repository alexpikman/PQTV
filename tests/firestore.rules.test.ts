import assert from 'node:assert/strict';
import test from 'node:test';

const projectId = 'demo-pqtv';
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const documentsUrl = `http://${emulatorHost}/v1/projects/${projectId}/databases/(default)/documents`;

function base64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function authToken(uid: string, email: string, emailVerified: boolean): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url({ alg: 'none', typ: 'JWT' });
  const payload = base64Url({
    iss: `https://securetoken.google.com/${projectId}`,
    aud: projectId,
    auth_time: now,
    user_id: uid,
    sub: uid,
    iat: now,
    exp: now + 3600,
    email,
    email_verified: emailVerified,
    firebase: {
      identities: { email: [email] },
      sign_in_provider: 'custom',
    },
  });
  return `${header}.${payload}.`;
}

async function firestoreRequest(
  path: string,
  token: string,
  method = 'GET',
  body?: unknown
): Promise<Response> {
  return fetch(`${documentsUrl}/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function commitWrites(token: string, writes: unknown[]): Promise<Response> {
  return fetch(`${documentsUrl}:commit`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ writes }),
  });
}

function categoryCreateWrite(id: string, name: string, uid: string, extra = false) {
  const fields: Record<string, unknown> = {
    id: { stringValue: id },
    name: { stringValue: name },
    createdByUid: { stringValue: uid },
    updatedByUid: { stringValue: uid },
  };
  if (extra) fields.unexpected = { stringValue: 'not-allowed' };
  return {
    update: {
      name: `projects/${projectId}/databases/(default)/documents/categories/${id}`,
      fields,
    },
    updateTransforms: [
      { fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' },
      { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
    ],
    currentDocument: { exists: false },
  };
}

test('Firestore category rules enforce verified reads, admin writes, schema and immutable ownership', async () => {
  const id = `cat_rules_${Date.now().toString(36)}`;
  const adminUid = 'rules-admin';
  const admin = authToken(adminUid, 'alexpqtr@gmail.com', true);
  const verifiedViewer = authToken('rules-viewer', 'viewer@example.com', true);
  const unverifiedViewer = authToken('rules-unverified', 'viewer@example.com', false);

  const unverifiedRead = await firestoreRequest(`categories/${id}`, unverifiedViewer);
  assert.equal(unverifiedRead.status, 403, 'unverified users must not read categories');

  const viewerWrite = await commitWrites(verifiedViewer, [
    categoryCreateWrite(id, 'Спорт', 'rules-viewer'),
  ]);
  assert.equal(viewerWrite.status, 403, 'verified non-admin users must not create categories');

  const invalidSchemaWrite = await commitWrites(admin, [
    categoryCreateWrite(id, 'Спорт', adminUid, true),
  ]);
  assert.equal(invalidSchemaWrite.status, 403, 'category schema must reject unexpected fields');

  const create = await commitWrites(admin, [
    categoryCreateWrite(id, 'Спорт', adminUid),
  ]);
  assert.equal(create.status, 200, 'verified admin must create a valid category');

  const viewerRead = await firestoreRequest(`categories/${id}`, verifiedViewer);
  assert.equal(viewerRead.status, 200, 'verified users may read categories');

  const existing = await viewerRead.json() as {
    fields?: { createdAt?: { timestampValue?: string } };
  };
  const createdAt = existing.fields?.createdAt?.timestampValue;
  assert.ok(createdAt, 'createdAt must be stored as a Firestore timestamp');

  const invalidOwnerUpdate = await commitWrites(admin, [{
    update: {
      name: `projects/${projectId}/databases/(default)/documents/categories/${id}`,
      fields: {
        id: { stringValue: id },
        name: { stringValue: 'Спорт и отдых' },
        createdByUid: { stringValue: 'different-owner' },
        updatedByUid: { stringValue: adminUid },
        createdAt: { timestampValue: createdAt },
      },
    },
    updateTransforms: [
      { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
    ],
  }]);
  assert.equal(invalidOwnerUpdate.status, 403, 'createdByUid must remain immutable');

  const validUpdate = await commitWrites(admin, [{
    update: {
      name: `projects/${projectId}/databases/(default)/documents/categories/${id}`,
      fields: {
        id: { stringValue: id },
        name: { stringValue: 'Спорт и отдых' },
        createdByUid: { stringValue: adminUid },
        updatedByUid: { stringValue: adminUid },
        createdAt: { timestampValue: createdAt },
      },
    },
    updateTransforms: [
      { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
    ],
  }]);
  assert.equal(validUpdate.status, 200, 'admin may update category name while preserving ownership');

  const remove = await firestoreRequest(`categories/${id}`, admin, 'DELETE');
  assert.equal(remove.status, 200, 'admin may delete a category');
});
