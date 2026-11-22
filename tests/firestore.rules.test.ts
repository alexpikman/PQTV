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

test('Firestore invite rules require admin ownership and private email metadata', async () => {
  const id = 'a'.repeat(64);
  const adminUid = 'rules-admin';
  const admin = authToken(adminUid, 'alexpqtr@gmail.com', true);
  const viewer = authToken('rules-viewer', 'other@example.com', true);
  const invitePath = `invites/${id}`;
  const privatePath = `invites/${id}/private/info`;

  const create = await commitWrites(admin, [
    {
      update: {
        name: `projects/${projectId}/databases/(default)/documents/${invitePath}`,
        fields: {
          emailHash: { stringValue: id },
          name: { stringValue: 'Test invite' },
          playlists: { arrayValue: { values: [] } },
          enabled: { booleanValue: true },
          invitedByUid: { stringValue: adminUid },
          claimedUid: { stringValue: '' },
        },
      },
      updateTransforms: [
        { fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' },
        { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
      ],
      currentDocument: { exists: false },
    },
    {
      update: {
        name: `projects/${projectId}/databases/(default)/documents/${privatePath}`,
        fields: {
          emailHash: { stringValue: id },
          email: { stringValue: 'invitee@example.com' },
        },
      },
      updateTransforms: [
        { fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' },
        { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
      ],
      currentDocument: { exists: false },
    },
  ]);
  assert.equal(create.status, 200, 'admin may create invite and private email in one commit');

  const viewerRead = await firestoreRequest(invitePath, viewer);
  assert.equal(viewerRead.status, 403, 'unrelated verified users must not read invite metadata');

  const privateRead = await firestoreRequest(privatePath, admin);
  assert.equal(privateRead.status, 200, 'admin may read private invite email');

  const removePrivate = await firestoreRequest(privatePath, admin, 'DELETE');
  assert.equal(removePrivate.status, 200, 'admin may delete private invite email');
  const removeInvite = await firestoreRequest(invitePath, admin, 'DELETE');
  assert.equal(removeInvite.status, 200, 'admin may delete invite metadata');
});

test('Firestore channel alert rules preserve viewer identity on admin updates', async () => {
  const uid = 'rules-alert';
  const adminUid = 'rules-admin';
  const admin = authToken(adminUid, 'alexpqtr@gmail.com', true);
  const viewer = authToken('rules-viewer', 'viewer@example.com', true);
  const path = `channel_alerts/${uid}`;
  const documentName = `projects/${projectId}/databases/(default)/documents/${path}`;
  const items = {
    arrayValue: {
      values: [{
        mapValue: {
          fields: {
            name: { stringValue: 'Channel One' },
            group: { stringValue: 'Спорт' },
            reason: { stringValue: 'Playback failed' },
          },
        },
      }],
    },
  };

  const create = await commitWrites(admin, [{
    update: {
      name: documentName,
      fields: {
        uid: { stringValue: uid },
        userLogin: { stringValue: 'viewer-login' },
        userName: { stringValue: 'Viewer Name' },
        totalChannels: { integerValue: '2' },
        unavailableCount: { integerValue: '1' },
        items,
        resolved: { booleanValue: false },
      },
    },
    updateTransforms: [
      { fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' },
      { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
    ],
    currentDocument: { exists: false },
  }]);
  assert.equal(create.status, 200, 'admin may create a valid channel alert');

  const viewerRead = await firestoreRequest(path, viewer);
  assert.equal(viewerRead.status, 403, 'unrelated viewers must not read another user alert');

  const adminRead = await firestoreRequest(path, admin);
  assert.equal(adminRead.status, 200);
  const existing = await adminRead.json() as {
    fields?: { createdAt?: { timestampValue?: string } };
  };
  const createdAt = existing.fields?.createdAt?.timestampValue;
  assert.ok(createdAt);

  const invalidIdentityUpdate = await commitWrites(admin, [{
    update: {
      name: documentName,
      fields: {
        uid: { stringValue: uid },
        userLogin: { stringValue: 'changed-login' },
        userName: { stringValue: 'Viewer Name' },
        totalChannels: { integerValue: '2' },
        unavailableCount: { integerValue: '1' },
        items,
        resolved: { booleanValue: false },
        createdAt: { timestampValue: createdAt },
      },
    },
    updateTransforms: [
      { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
    ],
  }]);
  assert.equal(invalidIdentityUpdate.status, 403, 'admin may not rewrite viewer identity fields');

  const validUpdate = await commitWrites(admin, [{
    update: {
      name: documentName,
      fields: {
        uid: { stringValue: uid },
        userLogin: { stringValue: 'viewer-login' },
        userName: { stringValue: 'Viewer Name' },
        totalChannels: { integerValue: '2' },
        unavailableCount: { integerValue: '0' },
        items: { arrayValue: { values: [] } },
        resolved: { booleanValue: true },
        createdAt: { timestampValue: createdAt },
      },
    },
    updateTransforms: [
      { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
    ],
  }]);
  assert.equal(validUpdate.status, 200, 'admin may resolve alert without changing viewer identity');

  const remove = await firestoreRequest(path, admin, 'DELETE');
  assert.equal(remove.status, 200);
});
