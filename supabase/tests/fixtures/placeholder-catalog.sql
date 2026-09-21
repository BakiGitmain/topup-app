-- TEST FIXTURE ONLY. Never deployed, never run against a real project.
-- The database test suites load this to have some products, packs and prices to buy, sell and break.
-- It used to be supabase/seed.sql, which put these placeholders into the live shop; seed.sql is now empty
-- and migration 20260925110000_remove_placeholder_products.sql removed them from the live database.
--
-- Names and prices are made up. The rows are explicitly ON so tests can buy from them.

insert into public.products (slug, name, category, tagline, glyph, tint, featured, sort_order, is_active) values
  ('freefire',         'Free Fire diamonds',       'games',         'Diamonds',            'diamond',    '#FBEBD0', true,  1, true),
  ('pubg',             'PUBG Mobile UC',           'games',         'Unknown Cash',        'coin',       '#DCEBFB', false, 2, true),
  ('mlbb',             'Mobile Legends diamonds',  'games',         'Diamonds',            'diamond',    '#E8E1FA', false, 3, true),
  ('codm',             'Call of Duty CP',          'games',         'COD Points',          'crosshair',  '#FBE0E4', false, 4, true),
  ('roblox',           'Roblox Robux',             'games',         'Robux',               'controller', '#FBEBD0', false, 5, true),

  ('google-play',      'Google Play gift card',    'gift-cards',    'Apps, games, more',   'gift',       '#D3F5E3', false, 6, true),
  ('netflix',          'Netflix gift card',        'gift-cards',    'Streaming credit',    'play',       '#FBE0E4', false, 7, true),
  ('steam',            'Steam wallet',             'gift-cards',    'Wallet credit',       'controller', '#DCEBFB', false, 8, true),
  ('spotify',          'Spotify gift card',        'gift-cards',    'Music credit',        'play',       '#E4F7C7', false, 9, true),

  ('pc-game-keys',     'PC game keys',             'game-keys',     'Steam keys',          'controller', '#E8E1FA', false, 10, true),

  ('telegram-premium', 'Telegram Premium',         'subscriptions', 'Premium plan',        'gift',       '#DCEBFB', false, 11, true),
  ('playstation-plus', 'PlayStation Plus',         'subscriptions', 'Online play',         'controller', '#DCEBFB', false, 12, true)
on conflict (slug) do nothing;

with seed (slug, label, price, sort_order) as (
  values
    ('freefire',          '100 Diamonds',    55,   1),
    ('freefire',          '310 Diamonds',    165,  2),
    ('freefire',          '520 Diamonds',    275,  3),
    ('freefire',          '1,060 Diamonds',  550,  4),

    ('pubg',              '60 UC',           90,   1),
    ('pubg',              '325 UC',          450,  2),
    ('pubg',              '660 UC',          900,  3),

    ('mlbb',              '86 Diamonds',     60,   1),
    ('mlbb',              '172 Diamonds',    120,  2),
    ('mlbb',              '429 Diamonds',    300,  3),
    ('mlbb',              '878 Diamonds',    600,  4),

    ('codm',              '80 CP',           120,  1),
    ('codm',              '420 CP',          600,  2),
    ('codm',              '880 CP',          1200, 3),

    ('roblox',            '80 Robux',        150,  1),
    ('roblox',            '400 Robux',       750,  2),
    ('roblox',            '800 Robux',       1500, 3),

    ('google-play',       'Br 250 card',     250,  1),
    ('google-play',       'Br 500 card',     500,  2),
    ('google-play',       'Br 1,000 card',   1000, 3),

    ('netflix',           'Br 600 card',     600,  1),
    ('netflix',           'Br 1,200 card',   1200, 2),
    ('netflix',           'Br 2,400 card',   2400, 3),

    ('steam',             'Br 500 wallet',   500,  1),
    ('steam',             'Br 1,000 wallet', 1000, 2),
    ('steam',             'Br 2,000 wallet', 2000, 3),

    ('spotify',           'Br 400 card',     400,  1),
    ('spotify',           'Br 800 card',     800,  2),
    ('spotify',           'Br 1,600 card',   1600, 3),

    ('pc-game-keys',      'Indie game key',  250,  1),
    ('pc-game-keys',      'Popular game key',800,  2),
    ('pc-game-keys',      'New release key', 2500, 3),

    ('telegram-premium',  '3 months',        1500, 1),
    ('telegram-premium',  '6 months',        2600, 2),
    ('telegram-premium',  '12 months',       4700, 3),

    ('playstation-plus',  '1 month',         700,  1),
    ('playstation-plus',  '3 months',        1900, 2),
    ('playstation-plus',  '12 months',       6500, 3)
)
insert into public.product_options (product_id, label, price, sort_order, is_active)
select p.id, s.label, s.price, s.sort_order, true
from seed s
join public.products p on p.slug = s.slug
where not exists (
  select 1 from public.product_options o where o.product_id = p.id
);
