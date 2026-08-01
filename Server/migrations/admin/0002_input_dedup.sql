ALTER TABLE input_revisions ADD COLUMN input_signature TEXT NULL;
CREATE UNIQUE INDEX input_revision_signature_idx ON input_revisions(recording_id, input_signature) WHERE input_signature IS NOT NULL;
