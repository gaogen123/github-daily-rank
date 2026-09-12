-- Latest verified project profile, independent of the daily ADS overwrite.
CREATE TABLE IF NOT EXISTS dwd.dwd_github_repo_profile_f (
    full_name VARCHAR(512) NOT NULL,
    repo_id BIGINT NULL,
    summary VARCHAR(4096) NULL,
    capabilities VARCHAR(65533) NULL,
    features VARCHAR(65533) NULL,
    use_cases VARCHAR(65533) NULL,
    keywords VARCHAR(8192) NULL,
    evidence_json VARCHAR(65533) NULL,
    source_urls VARCHAR(8192) NULL,
    metadata_json VARCHAR(65533) NULL,
    readme_sha VARCHAR(64) NULL,
    source_hash VARCHAR(64) NULL,
    source_truncated BOOLEAN NULL,
    model VARCHAR(255) NULL,
    prompt_version VARCHAR(64) NULL,
    generated_at DATETIME NULL,
    checked_at DATETIME NULL,
    status VARCHAR(32) NULL,
    last_error VARCHAR(2048) NULL,
    retry_count INT NULL,
    next_retry_at DATETIME NULL
) ENGINE=OLAP
PRIMARY KEY (full_name)
DISTRIBUTED BY HASH (full_name) BUCKETS 1
PROPERTIES (
    "replication_num" = "1",
    "enable_persistent_index" = "true"
);
