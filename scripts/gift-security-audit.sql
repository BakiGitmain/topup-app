-- Gifts: the permission audit, against the LIVE project. READ-ONLY (only catalog lookups, nothing is written).
--   npx supabase db query --linked -f scripts/gift-security-audit.sql
-- Every row should say ok = true. Mirrors supabase/tests/gift-security.test.mjs.
with fns(name, meant_for) as (values
  ('checkout_gift', 'customer'), ('claim_gift', 'customer'), ('find_recipient_by_email', 'customer'),
  ('gift_order_summary', 'customer'), ('my_redeem_codes', 'customer'), ('my_vault_gifts', 'customer'),
  ('redeem_code', 'customer'),
  ('expire_gifts_and_codes', 'server'),
  ('_giftable_order', 'internal'), ('_insert_redeem_code', 'internal'), ('_request_ip', 'internal'),
  ('create_gift', 'internal'), ('create_redeem_code', 'internal'), ('email_lookup_limits', 'internal'),
  ('generate_redeem_code', 'internal'), ('gift_deliver_on_claim', 'internal'), ('gift_on_paid', 'internal'),
  ('gift_ttl', 'internal'), ('guard_gift_backed_order', 'internal'), ('guard_gift_delivery_order', 'internal'),
  ('guard_gift_update', 'internal'), ('guard_recipient_with_pending_gifts', 'internal'),
  ('guard_redeem_code_update', 'internal'), ('redeem_limits', 'internal'),
  ('guard_gift_choice', 'internal'), ('gift_copy_choice', 'internal')
),
fn_checks as (
  select 'function ' || f.name || coalesce('(' || pg_get_function_identity_arguments(p.oid) || ')', ' -- MISSING') as check_name,
         p.oid is not null
           and not has_function_privilege('anon', p.oid, 'execute')
           and has_function_privilege('authenticated', p.oid, 'execute') = (f.meant_for = 'customer')
           and (f.meant_for <> 'server' or has_function_privilege('service_role', p.oid, 'execute')) as ok,
         'meant for ' || f.meant_for || coalesce(': anon=' || has_function_privilege('anon', p.oid, 'execute')
           || ' authenticated=' || has_function_privilege('authenticated', p.oid, 'execute'), '') as detail
    from fns f
    left join pg_proc p on p.proname = f.name and p.pronamespace = 'public'::regnamespace
),
tbl_checks as (
  select 'table ' || t.name as check_name,
         c.relrowsecurity
           and not (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('anon', c.oid, 'insert')
                    or has_table_privilege('anon', c.oid, 'update') or has_table_privilege('anon', c.oid, 'delete'))
           and has_table_privilege('authenticated', c.oid, 'select') = t.customer_reads
           and not (has_table_privilege('authenticated', c.oid, 'insert') or has_table_privilege('authenticated', c.oid, 'update')
                    or has_table_privilege('authenticated', c.oid, 'delete') or has_table_privilege('authenticated', c.oid, 'truncate')) as ok,
         'rls=' || c.relrowsecurity || ' customer_reads=' || has_table_privilege('authenticated', c.oid, 'select') as detail
    from (values ('gifts', true), ('redeem_codes', true), ('redeem_code_attempts', false), ('email_lookup_attempts', false)) t(name, customer_reads)
    join pg_class c on c.oid = ('public.' || t.name)::regclass
),
other_checks as (
  select 'orders: no customer writes' as check_name,
         not has_table_privilege('authenticated', 'public.orders', 'update') and not has_table_privilege('authenticated', 'public.orders', 'insert') as ok,
         '' as detail
  union all
  select 'every SECURITY DEFINER function pins search_path',
         count(*) = 0, coalesce(string_agg(p.proname, ' '), '')
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.prosecdef
     and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
  union all
  select 'part 4 migration applied (new code alphabet)',
         position('ABCDEFGHJKLMNPQRSTUVWXYZ23456789' in pg_get_functiondef('public.generate_redeem_code()'::regprocedure)) > 0, ''
)
select check_name, ok, detail from fn_checks
union all select check_name, ok, detail from tbl_checks
union all select check_name, ok, detail from other_checks
order by ok, check_name;
