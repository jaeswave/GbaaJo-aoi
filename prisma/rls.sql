-- Run this ONCE in the Supabase SQL Editor, right after `npx prisma db push`.
--
-- Why: Supabase automatically exposes every table in the "public" schema through a public web API
-- that anyone holding your project's "anon" key can call. Your tables are created by Prisma with that
-- protection OFF. GbaanJo never uses that web API (the Render server talks to the database directly),
-- so we turn the protection ON and give the public roles no access at all.
-- The server keeps working because it connects as the database owner.

ALTER TABLE "User"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Listing"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Order"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Feedback" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Waitlist" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;

-- Check: every row should say rowsecurity = true
SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
