ALTER TABLE IF EXISTS auth_users
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'admin';

UPDATE auth_users
SET role = 'admin'
WHERE role IS NULL OR role NOT IN ('admin', 'client');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'auth_users_role_check'
  ) THEN
    ALTER TABLE auth_users
      ADD CONSTRAINT auth_users_role_check CHECK (role IN ('admin', 'client'));
  END IF;
END
$$;
