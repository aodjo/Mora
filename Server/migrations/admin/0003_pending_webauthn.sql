ALTER TABLE auth_challenges ADD COLUMN pending_user_id TEXT NULL;
ALTER TABLE auth_challenges ADD COLUMN pending_email TEXT NULL;
ALTER TABLE auth_challenges ADD COLUMN pending_display_name TEXT NULL;
