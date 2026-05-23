export const API_BASE =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? "http://localhost:18080";

// Custom event name AuthGate listens on. Any fetch that comes back 401
// fires this so the gate can re-check status and flip to the login
// screen — handles session expiry without each page needing its own
// 401 handling.
export const AUTH_LOST_EVENT = "vfusion-auth-lost";

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    // include credentials so the session cookie travels with every
    // request — backend's CORS allows credentials and the cookie is
    // SameSite=Lax + HttpOnly.
    credentials: "include",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !path.startsWith("/api/auth/")) {
    // Don't dispatch when /api/auth/login itself 401s (wrong password) —
    // that's an expected, transient state the login form handles.
    window.dispatchEvent(new CustomEvent(AUTH_LOST_EVENT));
  }
  if (!res.ok) {
    let detail = `${method} ${path} → ${res.status}`;
    try {
      const j = await res.json();
      if (j?.detail) detail = `${detail}: ${j.detail}`;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const apiGet = <T>(p: string) => request<T>("GET", p);
export const apiPost = <T>(p: string, body: unknown) => request<T>("POST", p, body);
export const apiPut = <T>(p: string, body: unknown) => request<T>("PUT", p, body);
export const apiDelete = (p: string) => request<void>("DELETE", p);

// ---- Auth (single-user admin password) ----

export interface AuthStatus {
  password_set: boolean;
  authenticated: boolean;
  min_password_length: number;
  max_password_length: number;
}

// ---- Public config (tunnel + onboarding state) ----

export interface PublicConfig {
  tunnel_mode: "quick" | "named" | "lan";
  public_webhook_base: string | null;
  ephemeral: boolean;
  needs_onboarding: boolean;
  any_webhook_received: boolean;
  // True when the gate was dismissed via "Skip for now".
  onboarding_skipped: boolean;
  // True once a Verkada org is connected — onboarding is then complete.
  verkada_connected: boolean;
  // Product brand the dashboard renders in its header / modal / copy.
  // Source-of-truth lives in backend/app/brand.py.
  brand_name: string;
}

// ---- Settings ----

export interface SettingUsage {
  bytes: number | null;
  count: number | null;
  summary: string;
}

export interface SettingRow {
  key: string;
  label: string;
  unit: string;        // "days" | ""
  description: string;
  default: string;
  allow_zero: boolean; // when true, 0 = unlimited
  value: string | null;
  usage: SettingUsage | null;
  allow_clear: boolean; // when true, UI exposes a "Clear now" button
}

export interface SettingsResponse {
  items: SettingRow[];
}

// ---- Webhook events ----

export type Family = "camera" | "access" | "lpr" | "sensor" | "intercom" | "credential" | "alarm" | "unknown";
export type SignatureStatus =
  | "verified"
  | "bad_signature"
  | "unverified"
  | "missing_header";

export interface WebhookEventListItem {
  id: string;
  slug: string;
  method: string;
  path: string;
  body_size: number;
  remote_addr: string | null;
  received_at: string;
  family: Family | null;
  webhook_type: string | null;
  notification_type: string | null;
  signature_status: SignatureStatus | null;
}

export interface WebhookEventListResponse {
  items: WebhookEventListItem[];
  total: number;
  unknown_count: number;
}

export interface WebhookEvent {
  id: string;
  slug: string;
  method: string;
  path: string;
  query_string: string;
  headers: Record<string, string>;
  body_json: unknown;
  body_text: string | null;
  body_size: number;
  remote_addr: string | null;
  received_at: string;
  family: Family | null;
  webhook_type: string | null;
  notification_type: string | null;
  org_id: string | null;
  signature_status: SignatureStatus | null;
}

export interface UnrecognizedGroup {
  webhook_type: string | null;
  notification_type: string | null;
  count: number;
  last_seen: string;
  sample_event_id: string;
}

// ---- Connections ----

export interface ConnectionFieldSpec {
  name: string;
  label: string;
  type: "text" | "secret";
  required: boolean;
  help?: string;
  // If true, the form renders a "Generate" button next to the input
  // that fills it with a cryptographically random string. Plus a Copy
  // button once the field has a value. For shared-secret-style fields
  // where the user has to paste the same value into both systems.
  generate?: boolean;
}

export interface ConnectionTypeSpec {
  label: string;
  description: string;
  external_id_field?: string;
  required_for_setup?: string;
  fields: ConnectionFieldSpec[];
}

export interface Connection {
  id: string;
  type: string;
  name: string;
  external_id: string | null;
  setup_complete: boolean;
  cameras_last_synced_at: string | null;
  camera_count: number;
  doors_last_synced_at: string | null;
  door_count: number;
  helix_events_last_synced_at: string | null;
  helix_event_count: number;
  scenarios_last_synced_at: string | null;
  scenario_count: number;
  created_at: string;
  updated_at: string;
}

// ---- Flow templates (built-in starter flows) ----

export interface FlowTemplateListItem {
  id: string;
  name: string;
  category: string | null;
  description: string | null;
  summary: string | null;
  trigger_type: string;
  default_name: string;
}

export interface FlowTemplateNode {
  id: string;
  name: string;
  kind: "action" | "condition";
  action_type: string | null;
  config: Record<string, unknown>;
  position?: { x: number; y: number } | null;
}

export interface FlowTemplateEdge {
  id: string;
  source: string;
  target: string;
  branch?: "true" | "false" | null;
}

export interface FlowTemplateDetail extends FlowTemplateListItem {
  flow: {
    trigger_type: string;
    trigger_config: Record<string, unknown>;
    nodes: FlowTemplateNode[];
    edges: FlowTemplateEdge[];
  };
}

// ---- Flow export / import format ----

export interface FlowExportFormat {
  format: "vfusion-flow";
  version: number;
  name: string;
  trigger_type: string;
  trigger_config: Record<string, unknown>;
  nodes: FlowTemplateNode[];
  edges: FlowTemplateEdge[];
}

export interface PromptTemplate {
  id: string;
  name: string;
  value: string;
  created_at: string;
  updated_at: string;
}

// ---- Webhook media assets ----

export interface WebhookAsset {
  id: string;
  source_field: string;
  source_url: string;
  content_type: string | null;
  file_size: number | null;
  status: "pending" | "ready" | "failed";
  error: string | null;
  created_at: string;
  expires_at: string;
}

// ---- Trigger sample fields (variable picker) ----

export interface TriggerField {
  path: string;
  sample: unknown;
  type: string;
}

// ---- Verkada API catalog ----

export interface ApiSpec {
  id: string;
  namespace: string;
  url: string;
  title: string | null;
  api_version: string | null;
  openapi_version: string | null;
  fetch_status: string;
  fetch_error: string | null;
  last_fetched_at: string | null;
  last_changed_at: string | null;
  endpoint_count: number;
}

export interface ApiEndpoint {
  id: string;
  namespace: string;
  method: string;
  path: string;
  operation_id: string | null;
  summary: string | null;
  tags: string[] | null;
  docs_url: string | null;
  first_seen_at: string;
  last_seen_at: string;
  last_changed_at: string;
  deleted_at: string | null;
}

export interface ApiEndpointDetail extends ApiEndpoint {
  description: string | null;
  raw: unknown;
}

export interface ApiEndpointList {
  items: ApiEndpoint[];
  total: number;
}

export interface VerkadaCamera {
  connection_id: string;
  camera_id: string;
  name: string | null;
  site: string | null;
  site_id: string | null;
  model: string | null;
  serial: string | null;
  status: string | null;
  location: string | null;
  synced_at: string | null;
}

// ---- Verkada taxonomy ----

export interface TaxonomyEntry {
  label: string;
  webhook_type: string;
  notification_types: string[] | null;
  filter_fields: string[];
}

export type Taxonomy = Record<string, TaxonomyEntry>;

// ---- Flows ----

export interface RunEvent {
  id: string;
  step_name: string | null;
  phase: string | null;
  status: string | null;
  message: string | null;
  ts: string;
}


export interface ActionFieldSpec {
  name: string;
  label: string;
  type:
    | "text"
    | "connection_ref"
    | "door_ref"
    | "verkada_endpoint_ref"
    | "verkada_request_params"
    | "json"
    | "operator"
    | "select"
    | "helix_event_ref"
    | "helix_attributes";
  required: boolean;
  help?: string;
  connection_type?: string;
  default_template?: string;
  templates?: { name: string; value: string }[];
  options?: {
    value: string;
    label: string;
    tier?: string;
    preview?: boolean;
    tagline?: string;
  }[];
  default?: string;
  docs_url?: string;
  group?: string;
  // For helix_event_ref: which sibling fields the dropdown reads/writes.
  connection_field?: string;
  attributes_field?: string;
  // For helix_attributes: which sibling fields hold the event_type and connection.
  event_type_field?: string;
  // For verkada_request_params: which sibling field holds the endpoint_id
  // whose OpenAPI schema drives the rendered controls.
  endpoint_field?: string;
}

export interface HelixEventType {
  id: string;
  event_type_uid: string;
  name: string | null;
  event_schema: Record<string, string> | null;
}

export interface ActionSpec {
  kind: "action" | "condition";
  label: string;
  description: string;
  default_step_name?: string;
  schema: { fields: ActionFieldSpec[] };
  output_sample: unknown;
  operators?: string[];
}

export interface FlowNode {
  id: string;
  name: string;
  kind: "action" | "condition";
  action_type: string | null;
  config: Record<string, unknown>;
  position?: { x: number; y: number } | null;
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  branch: "true" | "false" | null;
}

export interface Flow {
  id: string;
  name: string;
  enabled: boolean;
  trigger_type: string;
  trigger_config: {
    // Webhook fields:
    family?: string;
    notification_type?: string;
    filters?: Record<string, string>;
    // Schedule fields:
    kind?: "interval" | "daily" | "weekly";
    every_minutes?: number;
    hour?: number;
    minute?: number;
    weekday?: number;
  };
  node_samples?: Record<string, unknown>;
  last_scheduled_at?: string | null;
  nodes: FlowNode[];
  edges: FlowEdge[];
  created_at: string;
  updated_at: string;
}

// ---- Runs ----

export interface RunListItem {
  id: string;
  flow_id: string | null;
  flow_name: string | null;
  webhook_event_id: string | null;
  status: "pending" | "running" | "success" | "failed";
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export interface RunStep {
  name: string;
  type: string;
  kind?: "action" | "condition";
  status: "running" | "success" | "failed" | "skipped";
  output?: unknown;
  error?: string;
  started_at?: string;
  finished_at?: string;
}

export interface RunDetail extends RunListItem {
  input: unknown;
  output: unknown;
  error: string | null;
  steps: RunStep[];
}

export interface RunListResponse {
  items: RunListItem[];
  total: number;
}

// ---- Verkada resources ----

export interface KnownDoor {
  door_id: string;
  name: string | null;
  site_name: string | null;
  last_seen: string | null;
}
