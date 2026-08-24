-- V18: Add local folder import support columns to projects table.
ALTER TABLE projects ADD COLUMN local_path TEXT;
ALTER TABLE projects ADD COLUMN source_type VARCHAR(20) DEFAULT 'GITHUB';
