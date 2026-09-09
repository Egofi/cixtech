export type Env = Record<string, string | undefined>;

export interface DatabaseUrls {
  url: string;
  directUrl: string;
  hasDirect: boolean;
}

export interface OpenDatabaseOptions {
  direct?: boolean;
  maxConnections?: number;
  schema?: string;
}
