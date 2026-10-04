'use strict';

// Pure row policy. This module performs no I/O and grants no DB/read/restore authority.
// Reviewed source inventory; migration hashes are pinned literals, never approved from input.
const { types: { isProxy } } = require('node:util');

const MIGRATIONS = [
  {
    "version": 1,
    "filename": "V1__init.sql",
    "sha256": "2d66ab364af115a9ab667408b7de5d23a47155542461f9a274401d7c29895408"
  },
  {
    "version": 2,
    "filename": "V2__github_credentials_encryption.sql",
    "sha256": "c160aebd48a6ade090671ebdbbdac576daadc49528f605dc49bdcbbd65171646"
  },
  {
    "version": 3,
    "filename": "V3__job_checkpoint.sql",
    "sha256": "605aa36487fba7a0d3cde86bb812e0e1b2ba7fd3930f0d25c7f22009912a301e"
  },
  {
    "version": 4,
    "filename": "V4__inventory_area_evidence.sql",
    "sha256": "7b36146118238af44cc820f313b8faecd4925c2c4d1b34347dce54c2ccd4cfea"
  },
  {
    "version": 5,
    "filename": "V5__git_metadata.sql",
    "sha256": "8f3f4ebfb8441fdf639bf7591e3dfe3a8f3c909af4817534453093c46c7f5979"
  },
  {
    "version": 6,
    "filename": "V6__code_graph.sql",
    "sha256": "fd91e00297d35b66179691b8949707f92869987054098af5c37a7f9a9d6de5d2"
  },
  {
    "version": 7,
    "filename": "V7__infra_resources.sql",
    "sha256": "3726aa90f2c6f88ad71c272623b9833876d975bac14d055443454270cabccbcf"
  },
  {
    "version": 8,
    "filename": "V8__endpoints_entities_features.sql",
    "sha256": "f75bb652cfeccdf77844c163380fb25865de539f30358a55584133ee71273d5b"
  },
  {
    "version": 9,
    "filename": "V9__frontend_routes.sql",
    "sha256": "47770d58252a0a0eca32ed1251daabfdebb0ed580f46122d1a9ea3598f562cf7"
  },
  {
    "version": 10,
    "filename": "V10__flows.sql",
    "sha256": "dd3f01c31e22ee89462fbf1a916985e0fbd5481e6f00386ac98e79decc42e176"
  },
  {
    "version": 11,
    "filename": "V11__analysis_findings.sql",
    "sha256": "b87154a4cb46c248be8efb6f04ac2f5d3aa501de1dfa17a53ea2b7930c7138a6"
  },
  {
    "version": 12,
    "filename": "V12__ai_summaries.sql",
    "sha256": "bb2a3b0f91efcb80bee1298924501b3b743a0d4ad0c32c73ed2f04f9242890be"
  },
  {
    "version": 13,
    "filename": "V13__notes_tasks_search.sql",
    "sha256": "1ba6ad2d858e55f3b0dd102cb201ec2046491027e9a78b830597481aeebbb706"
  },
  {
    "version": 14,
    "filename": "V14__phase5_review_playground.sql",
    "sha256": "67abea8c68a7db85744a5bbd23e46d622e1b6ef8c7898fe02d54d6f208ca72ec"
  },
  {
    "version": 15,
    "filename": "V15__user_ai_settings.sql",
    "sha256": "921d4a018c5966c3c1cebd688df3c75f3b0b1467cffdab4194ae767f05c1fb55"
  },
  {
    "version": 16,
    "filename": "V16__user_ai_models.sql",
    "sha256": "ef420e5ca131b81edfdf810203b9c4a87db79d8e0df519d03fc023985e2137e5"
  },
  {
    "version": 17,
    "filename": "V17__summary_embedding_models.sql",
    "sha256": "fe9eaaef044673235ffa1c868553b7ab9d1498922cc7fae6074787c94ca97aca"
  },
  {
    "version": 18,
    "filename": "V18__local_folder_import.sql",
    "sha256": "f0c4b244401dbfbfdbe8fa7d4179dc56b58ac73637c09601b1a462e6d1db3954"
  },
  {
    "version": 19,
    "filename": "V19__finding_judgments.sql",
    "sha256": "3dfdb415b35e44a5ed280a2edca1b2fe489ad6f83abeaa9b89aa0d1c2b3e997a"
  },
  {
    "version": 20,
    "filename": "V20__desktop_local_identity.sql",
    "sha256": "5da83d9968df500eeebbdf588b9cfcd78f0441ae26b9c3e43776f53b0c2b3a99"
  },
  {
    "version": 21,
    "filename": "V21__cancelling_jobs_remain_exclusive.sql",
    "sha256": "77dafe22315d49fc34700fc780e482753e010cab17e9d25616cca4e1609c2fdb"
  },
  {
    "version": 22,
    "filename": "V22__local_source_approvals.sql",
    "sha256": "edcfc3a68b48f2d8ffcefcff33e6f4097c87492545c66b99fbb241086cd05d3a"
  },
  {
    "version": 23,
    "filename": "V23__retained_source_manifests.sql",
    "sha256": "3dc86d04e458b3caa9dffc6a1993e548929649890dce4c6e992e37d23e102024"
  },
  {
    "version": 24,
    "filename": "V24__ai_connection_preferences.sql",
    "sha256": "5c77edd63d6dc98f04d0b91278b365bd0413688731a52e7b87869a9db83cbad3"
  },
  {
    "version": 25,
    "filename": "V25__ai_cost_reservations.sql",
    "sha256": "b5d547a4f0a24f263b8cf53983c57e446e0c9ee90a8f5c64e347e6ec89b1f1ec"
  },
  {
    "version": 26,
    "filename": "V26__platform_source_identities.sql",
    "sha256": "c371145fd690b2418e2a79996e9842d1b3d5707324248a264c132eb81507d20b"
  },
  {
    "version": 27,
    "filename": "V27__file_analysis_outcomes.sql",
    "sha256": "451d6875544abfcb2d2b8b613741e3faed2fb5b762ed25d95421fd3f014fae5c"
  }
];

// Column tuple: name, normalized source SQL type, nullable, generation, row disposition.
// Every column is explicit. Adding a migration/column requires policy review, not a runtime fallback.
const TABLE_DEFINITIONS = [
  ["users", "user-profile", [
    ["id", "bigint", false, "serial", "keep"],
    ["github_id", "bigint", true, "none", "keep"],
    ["login", "text", false, "none", "keep"],
    ["name", "text", true, "none", "keep"],
    ["avatar_url", "text", true, "none", "keep"],
    ["created_at", "timestamptz", false, "none", "keep"],
    ["updated_at", "timestamptz", false, "none", "keep"],
    ["local_key", "text", true, "none", "omit"],
    ["identity_type", "text", false, "none", "keep"],
  ]],
  ["github_credentials", "excluded", [
    ["id", "bigint", false, "serial", "omit"],
    ["user_id", "bigint", false, "none", "omit"],
    ["kind", "text", false, "none", "omit"],
    ["encrypted_token", "text", false, "none", "omit"],
    ["scopes", "text", true, "none", "omit"],
    ["expires_at", "timestamptz", true, "none", "omit"],
    ["created_at", "timestamptz", false, "none", "omit"],
    ["updated_at", "timestamptz", false, "none", "omit"],
    ["nonce", "bytea", false, "none", "omit"],
    ["key_version", "integer", false, "none", "omit"],
  ]],
  ["projects", "project-metadata", [
    ["id", "bigint", false, "serial", "keep"],
    ["user_id", "bigint", false, "none", "keep"],
    ["name", "text", false, "none", "keep"],
    ["repo_owner", "text", false, "none", "keep"],
    ["repo_name", "text", false, "none", "keep"],
    ["default_branch", "text", true, "none", "keep"],
    ["clone_path", "text", true, "none", "omit"],
    ["current_snapshot_id", "bigint", true, "none", "keep"],
    ["created_at", "timestamptz", false, "none", "keep"],
    ["updated_at", "timestamptz", false, "none", "keep"],
    ["pulls_etag", "text", true, "none", "omit"],
    ["local_path", "text", true, "none", "omit"],
    ["source_type", "varchar(20)", true, "none", "keep"],
    ["current_generation_id", "uuid", true, "none", "keep"],
  ]],
  ["snapshots", "data", [
    ["id", "bigint", false, "serial", "keep"],
    ["project_id", "bigint", false, "none", "keep"],
    ["commit_sha", "text", false, "none", "keep"],
    ["status", "text", false, "none", "keep"],
    ["analyzed_at", "timestamptz", true, "none", "keep"],
    ["created_at", "timestamptz", false, "none", "keep"],
    ["source_contract_version", "integer", false, "none", "keep"],
  ]],
  ["project_area_selections", "data", [
    ["id", "bigint", false, "serial", "keep"],
    ["project_id", "bigint", false, "none", "keep"],
    ["area_type", "text", false, "none", "keep"],
    ["selected", "boolean", false, "none", "keep"],
    ["created_at", "timestamptz", false, "none", "keep"],
    ["updated_at", "timestamptz", false, "none", "keep"],
  ]],
  ["analysis_jobs", "historical-job", [
    ["id", "bigint", false, "serial", "keep"],
    ["project_id", "bigint", false, "none", "keep"],
    ["snapshot_id", "bigint", true, "none", "keep"],
    ["type", "text", false, "none", "keep"],
    ["status", "text", false, "none", "keep"],
    ["error", "text", true, "none", "omit"],
    ["created_at", "timestamptz", false, "none", "keep"],
    ["updated_at", "timestamptz", false, "none", "keep"],
    ["started_at", "timestamptz", true, "none", "keep"],
    ["finished_at", "timestamptz", true, "none", "keep"],
    ["failure_code", "varchar(64)", true, "none", "keep"],
  ]],
  ["analysis_job_steps", "historical-step", [
    ["id", "bigint", false, "serial", "keep"],
    ["job_id", "bigint", false, "none", "keep"],
    ["step_key", "text", false, "none", "keep"],
    ["seq", "integer", false, "none", "keep"],
    ["status", "text", false, "none", "keep"],
    ["progress_pct", "integer", true, "none", "keep"],
    ["error", "text", true, "none", "omit"],
    ["started_at", "timestamptz", true, "none", "keep"],
    ["finished_at", "timestamptz", true, "none", "keep"],
    ["attempt", "integer", false, "none", "keep"],
  ]],
  ["files", "data", [
    ["id", "bigint", false, "serial", "keep"],
    ["snapshot_id", "bigint", false, "none", "keep"],
    ["path", "text", false, "none", "keep"],
    ["language", "text", true, "none", "keep"],
    ["size", "bigint", false, "none", "keep"],
    ["line_count", "integer", true, "none", "keep"],
    ["content_hash", "text", false, "none", "keep"],
    ["analysis_status", "varchar(32)", false, "none", "keep"],
    ["analysis_reason", "varchar(128)", true, "none", "keep"],
    ["analysis_targeted", "boolean", false, "none", "keep"],
  ]],
  ["snapshot_inventory_measurements", "data", [
    ["snapshot_id", "bigint", false, "none", "keep"],
    ["discovered_files", "integer", false, "none", "keep"],
    ["excluded_for_count", "integer", false, "none", "keep"],
    ["excluded_for_size", "integer", false, "none", "keep"],
    ["excluded_binary", "integer", false, "none", "keep"],
    ["excluded_submodules", "integer", false, "none", "keep"],
  ]],
  ["project_areas", "data", [
    ["id", "bigint", false, "serial", "keep"],
    ["snapshot_id", "bigint", false, "none", "keep"],
    ["area_type", "text", false, "none", "keep"],
    ["confidence", "double precision", false, "none", "keep"],
    ["summary", "text", true, "none", "keep"],
  ]],
  ["area_technologies", "data", [
    ["id", "bigint", false, "serial", "keep"],
    ["area_id", "bigint", false, "none", "keep"],
    ["name", "text", false, "none", "keep"],
    ["version", "text", true, "none", "keep"],
  ]],
  ["evidences", "data", [
    ["id", "bigint", false, "serial", "keep"],
    ["project_id", "bigint", false, "none", "keep"],
    ["kind", "text", false, "none", "keep"],
    ["file_path", "text", true, "none", "keep"],
    ["line_start", "integer", true, "none", "keep"],
    ["line_end", "integer", true, "none", "keep"],
    ["commit_sha", "text", true, "none", "keep"],
    ["pr_number", "integer", true, "none", "keep"],
    ["url", "text", true, "none", "keep"],
    ["excerpt", "text", true, "none", "keep"],
    ["created_by", "text", false, "none", "keep"],
    ["created_at", "timestamptz", false, "none", "keep"],
  ]],
  ["evidence_links", "data", [
    ["id", "bigint", false, "serial", "keep"],
    ["evidence_id", "bigint", false, "none", "keep"],
    ["subject_type", "text", false, "none", "keep"],
    ["subject_id", "bigint", false, "none", "keep"],
  ]],
  ["commits", "data", [
    ["id", "bigint", false, "serial", "keep"],
    ["project_id", "bigint", false, "none", "keep"],
    ["sha", "text", false, "none", "keep"],
    ["author", "text", true, "none", "keep"],
    ["message", "text", true, "none", "keep"],
    ["committed_at", "timestamptz", true, "none", "keep"],
    ["additions", "integer", false, "none", "keep"],
    ["deletions", "integer", false, "none", "keep"],
  ]],
  ["commit_files", "data", [
    ["id", "bigint", false, "serial", "keep"],
    ["commit_id", "bigint", false, "none", "keep"],
    ["path", "text", false, "none", "keep"],
    ["change_type", "text", false, "none", "keep"],
  ]],
  ["branches", "data", [
    ["id", "bigint", false, "serial", "keep"],
    ["project_id", "bigint", false, "none", "keep"],
    ["name", "text", false, "none", "keep"],
    ["head_sha", "text", false, "none", "keep"],
  ]],
  ["tags", "data", [
    ["id", "bigint", false, "serial", "keep"],
    ["project_id", "bigint", false, "none", "keep"],
    ["name", "text", false, "none", "keep"],
    ["head_sha", "text", false, "none", "keep"],
  ]],
  ["pull_requests", "data", [
    ["id", "bigint", false, "serial", "keep"],
    ["project_id", "bigint", false, "none", "keep"],
    ["number", "integer", false, "none", "keep"],
    ["title", "text", true, "none", "keep"],
    ["body", "text", true, "none", "keep"],
    ["state", "text", false, "none", "keep"],
    ["author", "text", true, "none", "keep"],
    ["merged_at", "timestamptz", true, "none", "keep"],
    ["head_sha", "text", true, "none", "keep"],
    ["base_sha", "text", true, "none", "keep"],
  ]],
  ["graph_nodes", "data", [
    ["id", "bigint", false, "serial", "keep"],
    ["snapshot_id", "bigint", false, "none", "keep"],
    ["node_type", "text", false, "none", "keep"],
    ["natural_key", "text", false, "none", "keep"],
    ["name", "text", false, "none", "keep"],
    ["file_id", "bigint", true, "none", "keep"],
    ["line_start", "integer", true, "none", "keep"],
    ["line_end", "integer", true, "none", "keep"],
    ["area_type", "text", true, "none", "keep"],
    ["metadata", "jsonb", false, "none", "keep"],
  ]],
  ["graph_edges", "data", [
    ["id", "bigint", false, "serial", "keep"],
    ["snapshot_id", "bigint", false, "none", "keep"],
    ["source_node_id", "bigint", false, "none", "keep"],
    ["target_node_id", "bigint", false, "none", "keep"],
    ["edge_type", "text", false, "none", "keep"],
    ["confidence", "text", false, "none", "keep"],
    ["metadata", "jsonb", false, "none", "keep"],
  ]],
  ["infra_resources", "data", [
    ["id", "bigint", false, "serial", "keep"],
    ["snapshot_id", "bigint", false, "none", "keep"],
    ["node_id", "bigint", false, "none", "keep"],
    ["kind", "text", false, "none", "keep"],
    ["name", "text", false, "none", "keep"],
    ["source_path", "text", true, "none", "keep"],
  ]],
  ["api_endpoints", "data", [
    ["id", "bigint", false, "serial", "keep"],
    ["snapshot_id", "bigint", false, "none", "keep"],
    ["node_id", "bigint", false, "none", "keep"],
    ["http_method", "text", false, "none", "keep"],
    ["path", "text", false, "none", "keep"],
    ["handler_key", "text", false, "none", "keep"],
  ]],
  ["db_entities", "data", [
    ["id", "bigint", false, "serial", "keep"],
    ["snapshot_id", "bigint", false, "none", "keep"],
    ["node_id", "bigint", false, "none", "keep"],
    ["entity_name", "text", false, "none", "keep"],
    ["table_name", "text", false, "none", "keep"],
    ["source", "text", false, "none", "keep"],
  ]],
  ["features", "data", [
    ["id", "bigint", false, "serial", "keep"],
    ["snapshot_id", "bigint", false, "none", "keep"],
    ["name", "text", false, "none", "keep"],
    ["description", "text", true, "none", "keep"],
    ["parent_id", "bigint", true, "none", "keep"],
    ["detection", "text", false, "none", "keep"],
    ["confidence", "double precision", false, "none", "keep"],
  ]],
  ["feature_links", "data", [
    ["id", "bigint", false, "serial", "keep"],
    ["feature_id", "bigint", false, "none", "keep"],
    ["node_id", "bigint", false, "none", "keep"],
    ["role", "text", false, "none", "keep"],
  ]],
  ["frontend_routes", "data", [
    ["id", "bigint", false, "serial", "keep"],
    ["snapshot_id", "bigint", false, "none", "keep"],
    ["node_id", "bigint", false, "none", "keep"],
    ["path", "text", false, "none", "keep"],
    ["component_key", "text", true, "none", "keep"],
  ]],
  ["flows", "data", [
    ["id", "bigint", false, "serial", "keep"],
    ["snapshot_id", "bigint", false, "none", "keep"],
    ["name", "text", false, "none", "keep"],
    ["kind", "text", false, "none", "keep"],
    ["entry_node_id", "bigint", true, "none", "keep"],
  ]],
  ["flow_steps", "data", [
    ["id", "bigint", false, "serial", "keep"],
    ["flow_id", "bigint", false, "none", "keep"],
    ["seq", "integer", false, "none", "keep"],
    ["node_id", "bigint", true, "none", "keep"],
    ["edge_id", "bigint", true, "none", "keep"],
    ["description", "text", true, "none", "keep"],
  ]],
  ["analysis_findings", "data", [
    ["id", "bigint", false, "serial", "keep"],
    ["snapshot_id", "bigint", false, "none", "keep"],
    ["area_type", "text", true, "none", "keep"],
    ["category", "text", false, "none", "keep"],
    ["severity", "text", false, "none", "keep"],
    ["title", "text", false, "none", "keep"],
    ["detail", "text", true, "none", "keep"],
    ["status", "text", false, "none", "keep"],
    ["node_id", "bigint", true, "none", "keep"],
  ]],
  ["summaries", "data", [
    ["id", "bigint", false, "serial", "keep"],
    ["snapshot_id", "bigint", false, "none", "keep"],
    ["subject_type", "text", false, "none", "keep"],
    ["subject_id", "bigint", true, "none", "keep"],
    ["level", "text", false, "none", "keep"],
    ["content", "text", false, "none", "keep"],
    ["embedding", "vector(1536)", true, "none", "keep"],
    ["model", "text", true, "none", "keep"],
    ["token_count", "integer", true, "none", "keep"],
    ["content_hash", "text", true, "none", "keep"],
    ["created_at", "timestamptz", false, "none", "keep"],
    ["embedding_model", "text", true, "none", "keep"],
  ]],
  ["ai_conversations", "data", [
    ["id", "bigint", false, "serial", "keep"],
    ["project_id", "bigint", false, "none", "keep"],
    ["snapshot_id", "bigint", true, "none", "keep"],
    ["user_id", "bigint", false, "none", "keep"],
    ["created_at", "timestamptz", false, "none", "keep"],
  ]],
  ["ai_messages", "data", [
    ["id", "bigint", false, "serial", "keep"],
    ["conversation_id", "bigint", false, "none", "keep"],
    ["role", "text", false, "none", "keep"],
    ["content", "text", false, "none", "keep"],
    ["context", "jsonb", true, "none", "keep"],
    ["claims", "jsonb", true, "none", "keep"],
    ["prompt_tokens", "integer", true, "none", "keep"],
    ["completion_tokens", "integer", true, "none", "keep"],
    ["created_at", "timestamptz", false, "none", "keep"],
  ]],
  ["ai_usage_logs", "legacy-usage", [
    ["id", "bigint", false, "serial", "keep"],
    ["user_id", "bigint", false, "none", "keep"],
    ["project_id", "bigint", true, "none", "keep"],
    ["provider", "text", false, "none", "keep"],
    ["model", "text", false, "none", "keep"],
    ["purpose", "text", false, "none", "keep"],
    ["prompt_tokens", "integer", false, "none", "keep"],
    ["completion_tokens", "integer", false, "none", "keep"],
    ["cost_estimate", "numeric", true, "none", "keep"],
    ["created_at", "timestamptz", false, "none", "keep"],
  ]],
  ["notes", "data", [
    ["id", "bigint", false, "serial", "keep"],
    ["project_id", "bigint", false, "none", "keep"],
    ["title", "text", false, "none", "keep"],
    ["content_md", "text", false, "none", "keep"],
    ["created_at", "timestamptz", false, "none", "keep"],
    ["updated_at", "timestamptz", false, "none", "keep"],
  ]],
  ["note_references", "data", [
    ["id", "bigint", false, "serial", "keep"],
    ["note_id", "bigint", false, "none", "keep"],
    ["subject_type", "text", false, "none", "keep"],
    ["subject_id", "bigint", true, "none", "keep"],
    ["raw_target", "text", false, "none", "keep"],
    ["label", "text", true, "none", "keep"],
  ]],
  ["tasks", "data", [
    ["id", "bigint", false, "serial", "keep"],
    ["project_id", "bigint", false, "none", "keep"],
    ["type", "text", false, "none", "keep"],
    ["title", "text", false, "none", "keep"],
    ["description", "text", false, "none", "keep"],
    ["status", "text", false, "none", "keep"],
    ["origin", "text", false, "none", "keep"],
    ["source_finding_id", "bigint", true, "none", "keep"],
    ["created_at", "timestamptz", false, "none", "keep"],
    ["updated_at", "timestamptz", false, "none", "keep"],
  ]],
  ["task_goals", "data", [
    ["id", "bigint", false, "serial", "keep"],
    ["task_id", "bigint", false, "none", "keep"],
    ["seq", "integer", false, "none", "keep"],
    ["content", "text", false, "none", "keep"],
    ["done", "boolean", false, "none", "keep"],
  ]],
  ["learning_records", "data", [
    ["id", "bigint", false, "serial", "keep"],
    ["task_id", "bigint", false, "none", "keep"],
    ["note", "text", false, "none", "keep"],
    ["created_at", "timestamptz", false, "none", "keep"],
  ]],
  ["pr_reviews", "data", [
    ["id", "bigint", false, "serial", "keep"],
    ["project_id", "bigint", false, "none", "keep"],
    ["pull_request_id", "bigint", false, "none", "keep"],
    ["summary", "text", false, "none", "keep"],
    ["origin", "text", false, "none", "keep"],
    ["created_at", "timestamptz", false, "none", "keep"],
  ]],
  ["pr_review_comments", "data", [
    ["id", "bigint", false, "serial", "keep"],
    ["review_id", "bigint", false, "none", "keep"],
    ["seq", "integer", false, "none", "keep"],
    ["file_path", "text", true, "none", "keep"],
    ["line", "integer", true, "none", "keep"],
    ["severity", "text", false, "none", "keep"],
    ["body", "text", false, "none", "keep"],
    ["confidence", "text", false, "none", "keep"],
    ["evidence", "jsonb", false, "none", "keep"],
  ]],
  ["playground_sessions", "data", [
    ["id", "bigint", false, "serial", "keep"],
    ["project_id", "bigint", false, "none", "keep"],
    ["title", "text", false, "none", "keep"],
    ["selected_paths", "jsonb", false, "none", "keep"],
    ["proposed_snippet", "text", false, "none", "keep"],
    ["last_question", "text", true, "none", "keep"],
    ["last_explanation", "text", true, "none", "keep"],
    ["last_claims", "jsonb", true, "none", "keep"],
    ["created_at", "timestamptz", false, "none", "keep"],
    ["updated_at", "timestamptz", false, "none", "keep"],
  ]],
  ["user_ai_settings", "keyless-ai-preference", [
    ["id", "bigint", false, "serial", "keep"],
    ["user_id", "bigint", false, "none", "keep"],
    ["provider", "text", false, "none", "keep"],
    ["encrypted_key", "text", false, "none", "omit"],
    ["nonce", "bytea", false, "none", "omit"],
    ["key_version", "integer", false, "none", "omit"],
    ["created_at", "timestamptz", false, "none", "keep"],
    ["updated_at", "timestamptz", false, "none", "keep"],
    ["model", "text", true, "none", "keep"],
  ]],
  ["finding_judgments", "data", [
    ["id", "bigint", false, "serial", "keep"],
    ["user_id", "bigint", false, "none", "keep"],
    ["project_id", "bigint", false, "none", "keep"],
    ["stable_key", "text", false, "none", "keep"],
    ["status", "text", false, "none", "keep"],
    ["reason", "text", false, "none", "keep"],
    ["rule_id", "text", false, "none", "keep"],
    ["rule_version", "text", false, "none", "keep"],
    ["evidence_fingerprint", "text", false, "none", "keep"],
    ["created_at", "timestamptz", false, "none", "keep"],
    ["updated_at", "timestamptz", false, "none", "keep"],
  ]],
  ["local_source_approvals", "excluded", [
    ["id", "bigint", false, "serial", "omit"],
    ["token_sha256", "char(64)", false, "none", "omit"],
    ["user_id", "bigint", false, "none", "omit"],
    ["purpose", "varchar(7)", false, "none", "omit"],
    ["project_id", "bigint", true, "none", "omit"],
    ["base_snapshot_id", "bigint", true, "none", "omit"],
    ["project_name", "varchar(255)", true, "none", "omit"],
    ["schema_version", "integer", false, "none", "omit"],
    ["canonical_root", "text", false, "none", "omit"],
    ["policy_version", "varchar(64)", false, "none", "omit"],
    ["limits_sha256", "char(64)", false, "none", "omit"],
    ["manifest_sha256", "char(64)", false, "none", "omit"],
    ["selected_files", "integer", false, "none", "omit"],
    ["selected_bytes", "bigint", false, "none", "omit"],
    ["issued_at", "timestamptz", false, "none", "omit"],
    ["expires_at", "timestamptz", false, "none", "omit"],
    ["consumed_at", "timestamptz", true, "none", "omit"],
    ["consumed_job_id", "bigint", true, "none", "omit"],
    ["revoked_at", "timestamptz", true, "none", "omit"],
    ["root_platform", "varchar(16)", false, "none", "omit"],
    ["root_identity", "text", false, "none", "omit"],
    ["root_owner", "text", true, "none", "omit"],
  ]],
  ["job_local_source_inputs", "excluded", [
    ["job_id", "bigint", false, "none", "omit"],
    ["project_id", "bigint", false, "none", "omit"],
    ["approval_token_sha256", "char(64)", false, "none", "omit"],
    ["purpose", "varchar(7)", false, "none", "omit"],
    ["base_snapshot_id", "bigint", true, "none", "omit"],
    ["schema_version", "integer", false, "none", "omit"],
    ["canonical_root", "text", false, "none", "omit"],
    ["policy_version", "varchar(64)", false, "none", "omit"],
    ["limits_sha256", "char(64)", false, "none", "omit"],
    ["manifest_sha256", "char(64)", false, "none", "omit"],
    ["selected_files", "integer", false, "none", "omit"],
    ["selected_bytes", "bigint", false, "none", "omit"],
    ["approved_at", "timestamptz", false, "none", "omit"],
    ["root_platform", "varchar(16)", false, "none", "omit"],
    ["root_identity", "text", false, "none", "omit"],
    ["root_owner", "text", true, "none", "omit"],
  ]],
  ["source_blobs", "data", [
    ["project_id", "bigint", false, "none", "keep"],
    ["sha256", "char(64)", false, "none", "keep"],
    ["byte_size", "bigint", false, "none", "keep"],
    ["key_id", "char(32)", false, "none", "keep"],
    ["created_at", "timestamptz", false, "none", "keep"],
  ]],
  ["source_manifests", "data", [
    ["id", "uuid", false, "none", "keep"],
    ["project_id", "bigint", false, "none", "keep"],
    ["snapshot_id", "bigint", false, "none", "keep"],
    ["job_id", "bigint", false, "none", "keep"],
    ["contract_version", "integer", false, "none", "keep"],
    ["producer_version", "varchar(64)", false, "none", "keep"],
    ["source_kind", "varchar(16)", false, "none", "keep"],
    ["approval_manifest_sha256", "char(64)", false, "none", "keep"],
    ["limits_sha256", "char(64)", false, "none", "keep"],
    ["policy_version", "varchar(64)", false, "none", "keep"],
    ["file_count", "integer", false, "none", "keep"],
    ["byte_size", "bigint", false, "none", "keep"],
    ["created_at", "timestamptz", false, "none", "keep"],
    ["sealed_at", "timestamptz", true, "none", "keep"],
  ]],
  ["source_manifest_entries", "data", [
    ["manifest_id", "uuid", false, "none", "keep"],
    ["project_id", "bigint", false, "none", "keep"],
    ["path", "text", false, "none", "keep"],
    ["blob_sha256", "char(64)", false, "none", "keep"],
    ["git_oid", "char(40)", false, "none", "keep"],
    ["byte_size", "bigint", false, "none", "keep"],
  ]],
  ["analysis_generations", "data", [
    ["id", "uuid", false, "none", "keep"],
    ["project_id", "bigint", false, "none", "keep"],
    ["snapshot_id", "bigint", false, "none", "keep"],
    ["source_manifest_id", "uuid", false, "none", "keep"],
    ["job_id", "bigint", false, "none", "keep"],
    ["contract_version", "integer", false, "none", "keep"],
    ["producer_version", "varchar(64)", false, "none", "keep"],
    ["rules_sha256", "char(64)", true, "none", "keep"],
    ["config_sha256", "char(64)", true, "none", "keep"],
    ["dependency_context_sha256", "char(64)", true, "none", "keep"],
    ["status", "varchar(16)", false, "none", "keep"],
    ["previous_committed_generation_id", "uuid", true, "none", "keep"],
    ["fencing_epoch", "bigint", false, "identity-always", "keep"],
    ["created_at", "timestamptz", false, "none", "keep"],
    ["committed_at", "timestamptz", true, "none", "keep"],
  ]],
  ["user_ai_preferences", "keyless-ai-preference", [
    ["user_id", "bigint", false, "none", "keep"],
    ["provider", "text", true, "none", "keep"],
    ["model", "text", true, "none", "keep"],
    ["connection_state", "text", false, "none", "omit"],
    ["revision", "bigint", false, "none", "omit"],
    ["created_at", "timestamptz", false, "none", "keep"],
    ["updated_at", "timestamptz", false, "none", "keep"],
  ]],
  // V25 rows are historical financial obligations/diagnostics, never activation capabilities.
  // Preserve all selected evidence for conservative merge; no receipt can release debt here.
  ["ai_budget_gate", "budget-diagnostic", [
    ["installation_id", "text", false, "none", "keep"],
    ["owner_user_id", "bigint", false, "none", "keep"],
    ["policy_revision", "bigint", false, "none", "keep"],
    ["policy_sha256", "text", false, "none", "keep"],
    ["daily_limit_micro_usd", "bigint", false, "none", "keep"],
    ["monthly_limit_micro_usd", "bigint", false, "none", "keep"],
    ["reconciliation_required", "boolean", false, "none", "keep"],
    ["legacy_liability_unresolved", "boolean", false, "none", "keep"],
    ["journal_sequence", "bigint", false, "none", "keep"],
    ["journal_hash", "text", false, "none", "keep"],
    ["journal_projection_sha256", "text", false, "none", "keep"],
    ["clock_high_water_ms", "bigint", false, "none", "keep"],
    ["created_at", "timestamptz", false, "none", "keep"],
    ["updated_at", "timestamptz", false, "none", "keep"],
  ]],
  ["ai_request_ledger", "financial-obligation", [
    ["request_id", "uuid", false, "none", "keep"],
    ["installation_id", "text", false, "none", "keep"],
    ["owner_user_id", "bigint", true, "none", "keep"],
    ["project_id", "bigint", true, "none", "keep"],
    ["snapshot_id", "bigint", true, "none", "keep"],
    ["approval_id", "uuid", true, "none", "keep"],
    ["plan_sha256", "text", false, "none", "keep"],
    ["payload_sha256", "text", false, "none", "keep"],
    ["wire_body_sha256", "text", false, "none", "keep"],
    ["dispatch_binding", "jsonb", false, "none", "keep"],
    ["budget_day", "date", false, "none", "keep"],
    ["price_version", "text", false, "none", "keep"],
    ["reserved_micro_usd", "bigint", false, "none", "keep"],
    ["status", "text", false, "none", "keep"],
    ["actual_micro_usd", "bigint", true, "none", "keep"],
    ["proof_sha256", "text", true, "none", "keep"],
    ["liability_floor_micro_usd", "bigint", false, "none", "keep"],
    ["conflict", "boolean", false, "none", "keep"],
    ["journal_sequence", "bigint", true, "none", "keep"],
    ["journal_hash", "text", true, "none", "keep"],
    ["created_at", "timestamptz", false, "none", "keep"],
    ["updated_at", "timestamptz", false, "none", "keep"],
  ]],
  ["ai_usage_evidence", "financial-evidence", [
    ["request_id", "uuid", false, "none", "keep"],
    ["proof_sha256", "text", false, "none", "keep"],
    ["main_epoch", "text", false, "none", "keep"],
    ["receipt_type", "text", false, "none", "keep"],
    ["provider_request_id", "text", true, "none", "keep"],
    ["usage_dimensions", "jsonb", false, "none", "keep"],
    ["actual_micro_usd", "bigint", false, "none", "keep"],
    ["created_at", "timestamptz", false, "none", "keep"],
  ]],
];

const POLICY_LIMITS = Object.freeze({
  maxTextBytes: 2 * 1024 * 1024,
  maxRowBytes: 8 * 1024 * 1024,
  maxDepth: 16,
  maxNodes: 16_384,
  maxMembers: 4_096,
  maxNumericChars: 256,
});

const MESSAGES = Object.freeze({
  SCHEMA_MISMATCH: 'The supplied schema inventory does not match the reviewed backup policy.',
  TABLE_UNKNOWN: 'The requested table is not in the reviewed backup policy.',
  TABLE_EXCLUDED: 'This table has no exportable data in the reviewed backup policy.',
  INVALID_ROW: 'The selected row does not match the reviewed backup policy.',
  ACTIVE_JOB: 'Active work cannot be projected as archived job history.',
  LIMIT_EXCEEDED: 'The selected row exceeds a fixed backup policy limit.',
});

class BackupExportPolicyError extends Error {
  constructor(code) {
    const safeCode = Object.hasOwn(MESSAGES, code) ? code : 'INVALID_ROW';
    super(MESSAGES[safeCode]);
    this.name = 'BackupExportPolicyError';
    this.code = safeCode;
  }
}

function fail(code = 'INVALID_ROW') { throw new BackupExportPolicyError(code); }
function deepFreeze(value) {
  // Only owned constants/results enter this function, never caller objects.
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const REVIEWED_SCHEMA = deepFreeze({
  migrations: MIGRATIONS,
  tables: TABLE_DEFINITIONS.map(([name, , columns]) => ({
    name,
    columns: columns.map(([column, type, nullable, generation]) => ({ name: column, type, nullable, generation })),
  })),
});
deepFreeze(TABLE_DEFINITIONS);

const TABLES = new Map(TABLE_DEFINITIONS.map(([name, kind, columns]) => [name, {
  name, kind, columns,
  selected: Object.freeze(columns.filter(column => column[4] === 'keep')),
  names: Object.freeze(columns.filter(column => column[4] === 'keep').map(column => column[0])),
}]));

// The only legacy reader is the reviewed V26 -> V27 additive migration. Export stays V27.
const OUTCOME_COLUMNS = ['analysis_status', 'analysis_reason', 'analysis_targeted'];
const V26_TABLES = new Map([...TABLES].filter(([name]) => name !== 'snapshot_inventory_measurements')
  .map(([name, table]) => [name, name === 'files' ? {
    ...table, columns: table.columns.filter(c => !OUTCOME_COLUMNS.includes(c[0])),
    names: table.names.filter(c => !OUTCOME_COLUMNS.includes(c)),
  } : table]));
const REVIEWED_V26_SCHEMA = deepFreeze({ migrations: MIGRATIONS.slice(0, 26),
  tables: REVIEWED_SCHEMA.tables.filter(t => t.name !== 'snapshot_inventory_measurements').map(t =>
    t.name === 'files' ? { ...t, columns: t.columns.filter(c => !OUTCOME_COLUMNS.includes(c.name)) } : t),
});
function upgradeV26FileRow(row) {
  const values = exactRecord(row, V26_TABLES.get('files').names, 'INVALID_ROW');
  return projectRow('files', { ...Object.fromEntries(values), analysis_status: 'LEGACY_UNMEASURED',
    analysis_reason: null, analysis_targeted: false });
}
function createBackupRestorePolicy(schema) {
  // Never infer a legacy version from a prefix, a caller version string, or missing columns.
  const root = exactRecord(schema, ['migrations', 'tables'], 'SCHEMA_MISMATCH');
  const legacy = arrayValues(root.get('migrations'), 'SCHEMA_MISMATCH', MIGRATIONS.length).length === 26;
  validateSchema(schema, legacy ? REVIEWED_V26_SCHEMA.migrations : MIGRATIONS, legacy ? V26_TABLES : TABLES);
  if (!legacy) return Object.freeze({ ...createBackupExportPolicy(schema), schema: REVIEWED_SCHEMA });
  return Object.freeze({ schema: REVIEWED_V26_SCHEMA,
    columnsFor(name) { const t = V26_TABLES.get(name); if (!t) fail('TABLE_UNKNOWN'); return t.names; },
    projectRow(name, values) {
      if (!V26_TABLES.has(name)) fail('TABLE_UNKNOWN');
      if (name !== 'files') return projectRow(name, values);
      const row = upgradeV26FileRow(values);
      return deepFreeze({ ...row, values: Object.fromEntries(Object.entries(row.values)
        .filter(([key]) => !OUTCOME_COLUMNS.includes(key))) });
    },
  });
}

// SQL CHECK enums plus the current application identity/source/job discriminators.
// Unconstrained free-form columns remain text; their contents are never executed here.
const ENUMS = deepFreeze({
  'users.identity_type': ['GITHUB', 'LOCAL', 'LOCAL_LINKED'],
  'projects.source_type': ['GITHUB', 'LOCAL'],
  'snapshots.status': ['ANALYZING', 'READY', 'FAILED'],
  'files.analysis_status': ['LEGACY_UNMEASURED', 'UNMEASURED', 'TARGETED', 'SUCCESS', 'PARTIAL', 'FAILED', 'UNSUPPORTED'],
  'analysis_jobs.type': ['IMPORT', 'REANALYZE'],
  'analysis_jobs.status': ['QUEUED', 'RUNNING', 'CANCELLING', 'DONE', 'FAILED', 'CANCELLED'],
  'analysis_job_steps.status': ['PENDING', 'RUNNING', 'DONE', 'FAILED', 'SKIPPED'],
  'project_areas.area_type': ['BACKEND', 'FRONTEND', 'MOBILE', 'DATABASE', 'INFRASTRUCTURE', 'DEVOPS',
    'SECURITY', 'TESTING', 'AI_ML', 'DOCUMENTATION', 'BUILD_TOOLING', 'OTHER'],
  'evidences.kind': ['FILE_LINE', 'COMMIT', 'PR', 'ISSUE', 'CONFIG', 'DEPENDENCY', 'URL'],
  'evidences.created_by': ['STATIC', 'AI'],
  'commit_files.change_type': ['ADD', 'MODIFY', 'DELETE', 'RENAME', 'COPY'],
  'graph_edges.confidence': ['CONFIRMED', 'LIKELY', 'POSSIBLE'],
  'infra_resources.kind': ['CONTAINER', 'CLOUD', 'CI'],
  'db_entities.source': ['JPA', 'MIGRATION'],
  'features.detection': ['STATIC', 'AI_ASSISTED'],
  'flows.kind': ['BACKEND', 'FE_BE', 'INFRA', 'EVENT'],
  'analysis_findings.severity': ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'],
  'analysis_findings.status': ['OPEN', 'CONFIRMED', 'DISMISSED'],
  'ai_messages.role': ['USER', 'ASSISTANT'],
  'tasks.type': ['DEVELOPMENT', 'LEARNING', 'REVIEW', 'RESEARCH', 'REFACTORING'],
  'tasks.status': ['DRAFT', 'OPEN', 'DONE', 'CANCELLED'],
  'tasks.origin': ['USER', 'AI'],
  'pr_reviews.origin': ['AI'],
  'pr_review_comments.severity': ['INFO', 'WARNING', 'ERROR'],
  'user_ai_settings.provider': ['openai', 'gemini'],
  'user_ai_preferences.provider': ['openai', 'gemini'],
  'finding_judgments.status': ['NEEDS_REVIEW', 'ACCEPTED', 'FALSE_POSITIVE', 'RESOLVED'],
  'source_manifests.source_kind': ['LOCAL'],
  'analysis_generations.status': ['STAGING', 'COMMITTED', 'FAILED', 'CANCELLED'],
  'ai_request_ledger.status': ['RESERVED', 'DISPATCHED', 'UNKNOWN_HELD', 'SETTLED'],
  'ai_usage_evidence.receipt_type': ['USAGE', 'PROVEN_NOT_SENT'],
});

// Inspect descriptors instead of invoking getters/toJSON/valueOf. Proxies are rejected before
// reflection; this is a data boundary, not a sandbox for hostile same-process JavaScript.
function properties(value, code, maximum = POLICY_LIMITS.maxMembers, expectedNames) {
  if (value === null || typeof value !== 'object' || isProxy(value)) fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  const keys = Reflect.ownKeys(value);
  if (keys.length > maximum) fail(code);
  if (expectedNames && (keys.length !== expectedNames.length
      || keys.some(key => typeof key !== 'string' || !expectedNames.includes(key)))) fail(code);
  const result = new Map();
  for (const key of keys) {
    if (typeof key !== 'string') fail(code);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(code);
    result.set(key, descriptor.value);
  }
  return result;
}

function exactRecord(value, names, code) {
  return properties(value, code, names.length, names);
}

function arrayValues(value, code, maximum = POLICY_LIMITS.maxMembers) {
  if (value === null || typeof value !== 'object' || isProxy(value) || !Array.isArray(value)
      || Object.getPrototypeOf(value) !== Array.prototype) fail(code);
  const length = Object.getOwnPropertyDescriptor(value, 'length').value;
  if (length > maximum) fail(code);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1) fail(code);
  const result = [];
  for (let i = 0; i < length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(code);
    result.push(descriptor.value);
  }
  return result;
}

function validateSchema(schema, migrationsExpected = MIGRATIONS, tablesExpected = TABLES) {
  const code = 'SCHEMA_MISMATCH';
  const root = exactRecord(schema, ['migrations', 'tables'], code);
  const migrations = arrayValues(root.get('migrations'), code, migrationsExpected.length);
  if (migrations.length !== migrationsExpected.length) fail(code);
  const seenVersions = new Set();
  for (const value of migrations) {
    const row = exactRecord(value, ['version', 'filename', 'sha256'], code);
    const version = row.get('version');
    if (!Number.isInteger(version) || version < 1 || version > migrationsExpected.length || seenVersions.has(version)) fail(code);
    seenVersions.add(version);
    const expected = migrationsExpected[version - 1];
    if (row.get('filename') !== expected.filename || row.get('sha256') !== expected.sha256) fail(code);
  }
  const tables = arrayValues(root.get('tables'), code, tablesExpected.size);
  if (tables.length !== tablesExpected.size) fail(code);
  const seenTables = new Set();
  for (const value of tables) {
    const table = exactRecord(value, ['name', 'columns'], code);
    const name = table.get('name');
    const expected = typeof name === 'string' ? tablesExpected.get(name) : undefined;
    if (!expected || seenTables.has(name)) fail(code);
    seenTables.add(name);
    const columns = arrayValues(table.get('columns'), code, expected.columns.length);
    if (columns.length !== expected.columns.length) fail(code);
    const expectedColumns = new Map(expected.columns.map(column => [column[0], column]));
    const seenColumns = new Set();
    for (const item of columns) {
      const column = exactRecord(item, ['name', 'type', 'nullable', 'generation'], code);
      const columnName = column.get('name');
      const defined = typeof columnName === 'string' ? expectedColumns.get(columnName) : undefined;
      if (!defined || seenColumns.has(columnName)) fail(code);
      seenColumns.add(columnName);
      if (column.get('type') !== defined[1] || column.get('nullable') !== defined[2]
          || column.get('generation') !== defined[3]) fail(code);
    }
  }
}

function charge(context, bytes) {
  context.bytes += bytes;
  if (context.bytes > POLICY_LIMITS.maxRowBytes) fail('LIMIT_EXCEEDED');
}
function visit(context, depth) {
  if (++context.nodes > POLICY_LIMITS.maxNodes || depth > POLICY_LIMITS.maxDepth) fail('LIMIT_EXCEEDED');
}
function fullMatch(pattern, value) { return pattern.exec(value)?.[0] === value; }

function textValue(value, context) {
  if (typeof value !== 'string') fail();
  if (value.length > POLICY_LIMITS.maxTextBytes || Buffer.byteLength(value, 'utf8') > POLICY_LIMITS.maxTextBytes) {
    fail('LIMIT_EXCEEDED');
  }
  // PostgreSQL text/JSONB cannot store NUL or unpaired UTF-16 surrogate values.
  let bytes = 2;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0 || (code >= 0xdc00 && code <= 0xdfff)) fail();
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(++i);
      if (!(low >= 0xdc00 && low <= 0xdfff)) fail();
      bytes += 4;
    } else if (code < 0x20) bytes += [8, 9, 10, 12, 13].includes(code) ? 2 : 6;
    else if (code === 34 || code === 92) bytes += 2;
    else bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
  }
  charge(context, bytes);
  return value;
}

function jsonValue(value, context, depth, ancestors) {
  visit(context, depth);
  if (value === null) { charge(context, 4); return null; }
  if (typeof value === 'string') return textValue(value, context);
  if (typeof value === 'boolean') { charge(context, 5); return value; }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0) || (Number.isInteger(value) && !Number.isSafeInteger(value))) fail();
    charge(context, String(value).length);
    return value;
  }
  if (typeof value !== 'object' || isProxy(value) || ancestors.has(value)) fail();
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items = arrayValues(value, 'INVALID_ROW');
      charge(context, 2 + items.length);
      return Object.freeze(items.map(item => jsonValue(item, context, depth + 1, ancestors)));
    }
    const entries = properties(value, 'INVALID_ROW');
    charge(context, 2 + entries.size * 2);
    const result = {};
    for (const [key, item] of entries) {
      textValue(key, context);
      // defineProperty preserves literal __proto__ keys without assigning a prototype.
      Object.defineProperty(result, key, { value: jsonValue(item, context, depth + 1, ancestors), enumerable: true });
    }
    return Object.freeze(result);
  } finally { ancestors.delete(value); }
}

function timestamp(value) {
  if (value.length > 27 || !fullMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z/, value)) fail();
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]
      || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) fail();
}

function dateValue(value) {
  if (!fullMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}/, value)) fail();
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) fail();
}

function columnValue(column, value, context) {
  const [, type, nullable] = column;
  visit(context, 0);
  if (value === null) {
    if (!nullable) fail();
    charge(context, 4);
    return null;
  }
  if (type === 'jsonb') {
    // The wrapper distinguishes SQL NULL from the JSON literal null without loss.
    const wrapped = exactRecord(value, ['json'], 'INVALID_ROW');
    charge(context, 9);
    return Object.freeze({ json: jsonValue(wrapped.get('json'), context, 0, new WeakSet()) });
  }
  if (type === 'vector(1536)') {
    const vector = arrayValues(value, 'INVALID_ROW', 1536);
    if (vector.length !== 1536) fail();
    charge(context, 2 + vector.length);
    for (const element of vector) {
      visit(context, 1);
      if (typeof element !== 'number' || !Number.isFinite(element) || Object.is(element, -0)
          || Math.abs(element) > 3.4028234663852886e38) fail();
      charge(context, String(element).length);
    }
    return Object.freeze(vector);
  }
  if (type === 'boolean') {
    if (typeof value !== 'boolean') fail();
    charge(context, 5); return value;
  }
  if (type === 'integer' || type === 'double precision') {
    if (typeof value !== 'number' || !Number.isFinite(value) || Object.is(value, -0)) fail();
    if (type === 'integer' && (!Number.isInteger(value) || value < -2147483648 || value > 2147483647)) fail();
    charge(context, String(value).length); return value;
  }
  textValue(value, context);
  if (type === 'bigint') {
    if (value.length > 20 || !fullMatch(/^(?:0|[1-9][0-9]*|-[1-9][0-9]*)/, value)) fail();
    const integer = BigInt(value);
    if (integer < -9223372036854775808n || integer > 9223372036854775807n) fail();
  } else if (type === 'numeric') {
    if (value.length > POLICY_LIMITS.maxNumericChars || !fullMatch(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?/, value)) fail();
  } else if (type === 'timestamptz') timestamp(value);
  else if (type === 'date') dateValue(value);
  else if (type === 'uuid') {
    if (!fullMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/, value)) fail();
  } else if (type.startsWith('varchar(') || type.startsWith('char(')) {
    const maximum = Number(type.slice(type.indexOf('(') + 1, -1));
    if ([...value].length > maximum) fail();
    if (type.startsWith('char(') && !fullMatch(new RegExp(`^[0-9a-f]{${maximum}}`), value)) fail();
  } else if (type !== 'text') fail();
  return value;
}

function validateRowState(table, values) {
  for (const [column, value] of Object.entries(values)) {
    const allowed = ENUMS[`${table}.${column}`];
    if (value !== null && allowed && !allowed.includes(value)) fail();
  }
  if ((table === 'analysis_jobs' && ['QUEUED', 'RUNNING', 'CANCELLING'].includes(values.status))
      || (table === 'analysis_job_steps' && values.status === 'RUNNING')) fail('ACTIVE_JOB');
  if (table === 'users' && ((values.identity_type === 'LOCAL') !== (values.github_id === null))) fail();
  if (table === 'user_ai_preferences' && values.model !== null && values.provider === null) fail();
  if (table === 'projects' && values.current_generation_id !== null && values.current_snapshot_id === null) fail();
  if (table === 'snapshots' && ![0, 1].includes(values.source_contract_version)) fail();
  if (table === 'snapshot_inventory_measurements') {
    for (const column of ['discovered_files', 'excluded_for_count', 'excluded_for_size', 'excluded_binary', 'excluded_submodules']) {
      if (values[column] < 0) fail();
    }
  }
  if (table === 'source_manifests' || table === 'analysis_generations') {
    if (values.contract_version !== 1) fail();
  }
  if (table === 'source_manifests') {
    if (values.file_count < 0 || values.file_count > 50000 || BigInt(values.byte_size) < 0n
        || BigInt(values.byte_size) > 536870912n) fail();
  }
  if (table === 'source_blobs' || table === 'source_manifest_entries') {
    if (BigInt(values.byte_size) < 0n || BigInt(values.byte_size) > 2097152n) fail();
  }
  if (table === 'source_manifest_entries' && (values.path.length === 0 || Buffer.byteLength(values.path, 'utf8') > 8192)) fail();
  if (table === 'analysis_generations' && ((values.status === 'COMMITTED') !== (values.committed_at !== null))) fail();
  if (table === 'ai_budget_gate' || table === 'ai_request_ledger' || table === 'ai_usage_evidence') {
    // Hashes are evidence references, not authenticated proof or an approval token.
    for (const [column, value] of Object.entries(values)) {
      if (value !== null && (column.endsWith('_sha256') || column === 'journal_hash')
          && !fullMatch(/^[0-9a-f]{64}/, value)) fail();
    }
    const nonnegative = table === 'ai_budget_gate'
      ? ['policy_revision', 'daily_limit_micro_usd', 'monthly_limit_micro_usd', 'journal_sequence', 'clock_high_water_ms']
      : table === 'ai_request_ledger'
        ? ['reserved_micro_usd', 'actual_micro_usd', 'liability_floor_micro_usd', 'journal_sequence']
        : ['actual_micro_usd'];
    for (const column of nonnegative) if (values[column] !== null && BigInt(values[column]) < 0n) fail();
    if (table === 'ai_budget_gate' && BigInt(values.owner_user_id) <= 0n) fail();
    if (table !== 'ai_budget_gate') {
      const metadata = values[table === 'ai_request_ledger' ? 'dispatch_binding' : 'usage_dimensions'].json;
      if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) fail();
    }
    if (table === 'ai_request_ledger') {
      if (values.status === 'SETTLED') {
        if (values.actual_micro_usd === null || values.proof_sha256 === null) fail();
      } else if (values.actual_micro_usd !== null || values.proof_sha256 !== null) fail();
    }
    if (table === 'ai_usage_evidence' && values.receipt_type === 'PROVEN_NOT_SENT'
        && values.actual_micro_usd !== '0') fail();
  }
}

function tableDefinition(name) {
  const result = typeof name === 'string' ? TABLES.get(name) : undefined;
  if (!result) fail('TABLE_UNKNOWN');
  return result;
}

function projectRow(name, row) {
  const table = tableDefinition(name);
  if (table.kind === 'excluded') fail('TABLE_EXCLUDED');
  // Shape validation precedes field interpretation. Excluded/unknown columns are rejected,
  // including accessors, rather than inspected/redacted. No credential column is selectable.
  const selected = exactRecord(row, table.names, 'INVALID_ROW');
  const context = { bytes: 2048, nodes: 0 }; // Conservative fixed envelope/key overhead.
  const values = {};
  for (const column of table.selected) {
    charge(context, column[0].length + 4);
    values[column[0]] = columnValue(column, selected.get(column[0]), context);
  }
  validateRowState(name, values);
  const result = { policyVersion: 1, table: name, kind: table.kind, values: Object.freeze(values) };
  if (table.kind === 'keyless-ai-preference') {
    result.settings = Object.freeze({ enabled: false, reconnectRequired: true, allowEnvironmentFallback: false });
  } else if (table.kind === 'historical-job' || table.kind === 'historical-step') {
    result.execution = Object.freeze({ resumable: false, dispatchAllowed: false });
  } else if (table.kind === 'legacy-usage') {
    result.accounting = Object.freeze({ authoritative: false, reconciliationRequired: true });
  } else if (table.kind === 'user-profile') {
    result.identity = Object.freeze({ authorityIncluded: false, ownerBindingRequired: true });
  } else if (table.kind === 'project-metadata') {
    result.sourceAccess = Object.freeze({ pathAuthorityIncluded: false });
  } else if (table.kind === 'budget-diagnostic' || table.kind === 'financial-obligation'
      || table.kind === 'financial-evidence') {
    // These are fixed data annotations for a future loader, not runtime enforcement.
    result.safety = Object.freeze({
      enabled: false, dispatchAllowed: false, activationAuthorityIncluded: false, reconciliationRequired: true,
    });
    result.accounting = table.kind === 'budget-diagnostic'
      ? Object.freeze({ historicalProjection: true, journalAuthorityIncluded: false, restoreMode: 'PREFERENCES_AND_DIAGNOSTICS' })
      : Object.freeze({ obligationData: true, conservativeMergeRequired: true, replaceJournal: false, releaseLiabilityAllowed: false });
  }
  return Object.freeze(result);
}

function createBackupExportPolicy(schemaInventory) {
  // A matching caller-supplied inventory is NOT verification of a live catalog or permission
  // to read/export/restore data. The future trusted catalog/ownership/safety gates are separate.
  validateSchema(schemaInventory);
  return Object.freeze({
    columnsFor(name) { return tableDefinition(name).names; },
    projectRow,
  });
}

module.exports = Object.freeze({ createBackupExportPolicy, createBackupRestorePolicy, upgradeV26FileRow, REVIEWED_SCHEMA, REVIEWED_V26_SCHEMA, POLICY_LIMITS, BackupExportPolicyError });
