declare module 'pg' {
  export interface QueryResult<Row = Record<string, unknown>> { rows: Row[]; rowCount: number | null; }
  export interface PoolClient {
    query<Row = Record<string, unknown>>(text: string, values?: unknown[]): Promise<QueryResult<Row>>;
    release(): void;
  }
  export class Pool {
    constructor(config?: { connectionString?: string; max?: number; idleTimeoutMillis?: number; connectionTimeoutMillis?: number });
    query<Row = Record<string, unknown>>(text: string, values?: unknown[]): Promise<QueryResult<Row>>;
    connect(): Promise<PoolClient>;
    end(): Promise<void>;
    on(event: string, listener: (error: Error) => void): this;
  }
}
