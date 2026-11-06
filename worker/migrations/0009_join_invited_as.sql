-- 0009_join_invited_as.sql
--
-- The name a share link meant for its joiner (`as` in the link), carried on the join
-- request it starts. A hint and nothing more: it is shown to whoever approves and offered
-- as the new member's name, and it grants no power and reserves no name. Additive: NULL on
-- every request made before it, and on any request made without a link.
ALTER TABLE join_requests ADD COLUMN invited_as TEXT;
