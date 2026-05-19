/**
 * Shared data models and types for both Frontend and Backend
 */

export interface Subscription {
  id: number;
  name: string;
  url: string;
  type: "source" | "rule";
  enabled: number;
  last_synced: string | null;
  item_count: number;
  created_at: string;
}

export interface SourceRow {
  id: number;
  subscription_id: number;
  book_source_url: string;
  name: string;
  group_name: string;
  enabled: number;
  raw_json: string;
  updated_at: string;
  // 以下为视图计算字段
  is_available?: number;
  last_checked?: string;
}

export interface RuleRow {
  id: number;
  subscription_id: number;
  name: string;
  pattern: string;
  replacement: string;
  enabled: number;
  raw_json: string;
  updated_at: string;
}

export interface Stats {
  subscriptions: {
    total: number;
    sources: number;
    rules: number;
  };
  sources: { 
    total?: number;
    enabled: number;
    available?: number;
    unavailable?: number;
  };
  rules: { 
    total?: number;
    enabled: number; 
  };
}

export interface PasskeyItem {
  id: string;
  name: string;
  created_at: string;
}

export interface StoredPasskey extends PasskeyItem {
  public_key: string;
  counter: number;
  transports?: string; // DB 存储为 JSON 字符串
}

export type Page = 'dashboard' | 'subscriptions' | 'sources' | 'rules' | 'assets' | 'settings';
