-- ============================================================
-- HACCP Logbook (Θερμοκρασίες ψυγείων + Πλάνο καθαρισμού) — Supabase schema
-- Τρέξε ολόκληρο αυτό το script στο Supabase Dashboard:
-- SQL Editor -> New query -> paste -> Run
-- ============================================================

-- Πίνακας ψυγείων/καταψυκτών
create table if not exists fridges (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  serial_number text,
  type text not null default 'ψυγείο',              -- 'ψυγείο' | 'κατάψυξη' | 'θάλαμος'
  min_temp numeric not null,
  max_temp numeric not null,
  location text,
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Πίνακας καταγραφών θερμοκρασίας
create table if not exists logs (
  id uuid primary key default gen_random_uuid(),
  fridge_id uuid references fridges(id) on delete set null,
  fridge_name text not null,        -- "φωτογραφία" του ονόματος τη στιγμή της καταγραφής
  fridge_serial text,               -- "φωτογραφία" του serial number τη στιγμή της καταγραφής
  temperature numeric not null,
  logged_at timestamptz not null default now(),
  in_range boolean not null,
  corrective_action text,
  note text,
  created_by text,
  created_at timestamptz not null default now()
);

create index if not exists logs_logged_at_idx on logs (logged_at desc);
create index if not exists logs_fridge_id_idx on logs (fridge_id);
create index if not exists fridges_sort_order_idx on fridges (sort_order);

-- Πίνακας εργασιών πλάνου καθαρισμού
create table if not exists cleaning_tasks (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  area text,
  frequency text not null default 'daily',   -- 'daily' | 'weekly' | 'monthly'
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Πίνακας καταγραφών καθαρισμού
create table if not exists cleaning_logs (
  id uuid primary key default gen_random_uuid(),
  task_id uuid references cleaning_tasks(id) on delete set null,
  task_name text not null,          -- "φωτογραφία" του ονόματος της εργασίας
  frequency text not null,          -- "φωτογραφία" της συχνότητας
  done boolean not null default true,
  responsible text not null,
  logged_at timestamptz not null default now(),
  note text,
  created_by text,
  created_at timestamptz not null default now()
);

create index if not exists cleaning_logs_logged_at_idx on cleaning_logs (logged_at desc);
create index if not exists cleaning_logs_task_id_idx on cleaning_logs (task_id);
create index if not exists cleaning_tasks_sort_order_idx on cleaning_tasks (sort_order);

-- Αν έτρεξες παλιότερα μια προηγούμενη έκδοση αυτού του script (χωρίς
-- serial number ή χωρίς πλάνο καθαρισμού) πάνω σε υπάρχουσα βάση, οι
-- παρακάτω γραμμές συμπληρώνουν μόνο ό,τι λείπει, χωρίς να πειράξουν
-- υπάρχοντα δεδομένα:
alter table fridges add column if not exists serial_number text;
alter table logs add column if not exists fridge_serial text;

-- ============================================================
-- Row Level Security
-- Μόνο συνδεδεμένοι (authenticated) χρήστες βλέπουν/γράφουν δεδομένα.
-- Το anon key είναι ασφαλές να είναι δημόσιο στον κώδικα — η
-- προστασία γίνεται εδώ, στις πολιτικές RLS.
-- ============================================================

alter table fridges enable row level security;
alter table logs enable row level security;
alter table cleaning_tasks enable row level security;
alter table cleaning_logs enable row level security;

drop policy if exists "authenticated full access fridges" on fridges;
create policy "authenticated full access fridges" on fridges
  for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

drop policy if exists "authenticated full access logs" on logs;
create policy "authenticated full access logs" on logs
  for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

drop policy if exists "authenticated full access cleaning_tasks" on cleaning_tasks;
create policy "authenticated full access cleaning_tasks" on cleaning_tasks
  for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

drop policy if exists "authenticated full access cleaning_logs" on cleaning_logs;
create policy "authenticated full access cleaning_logs" on cleaning_logs
  for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

-- ============================================================
-- (Προαιρετικό) Μερικά παραδείγματα ψυγείων — μπορείς να τα
-- διαγράψεις/αλλάξεις από την οθόνη "Ρυθμίσεις ψυγείων" της εφαρμογής.
-- ============================================================
insert into fridges (name, type, min_temp, max_temp, location, sort_order)
select * from (values
  ('Ψυγείο Κουζίνας 1', 'ψυγείο', 0::numeric, 4::numeric, 'Κουζίνα', 1),
  ('Κατάψυξη Αποθήκης', 'κατάψυξη', -22::numeric, -18::numeric, 'Αποθήκη', 2)
) as v(name, type, min_temp, max_temp, location, sort_order)
where not exists (select 1 from fridges);

-- ============================================================
-- Τυπικό πλάνο καθαρισμού HACCP εστιατορίου/επιχείρησης τροφίμων —
-- προσάρμοσέ το ελεύθερα από την οθόνη "Πλάνο καθαρισμού" της εφαρμογής
-- (προσθήκη, επεξεργασία, διαγραφή εργασιών).
-- ============================================================
insert into cleaning_tasks (name, area, frequency, sort_order)
select * from (values
  ('Καθαρισμός πάγκων εργασίας/κοπής', 'Κουζίνα', 'daily', 1),
  ('Καθαρισμός δαπέδου κουζίνας', 'Κουζίνα', 'daily', 2),
  ('Καθαρισμός εστιών/φούρνων (επιφανειακά)', 'Κουζίνα', 'daily', 3),
  ('Καθαρισμός καλαθιών απορριμμάτων', 'Κουζίνα', 'daily', 4),
  ('Καθαρισμός χώρου πλύσης σκευών', 'Κουζίνα', 'daily', 5),
  ('Καθαρισμός τουαλετών', 'Χώρος προσωπικού/πελατών', 'daily', 6),
  ('Καθαρισμός πάγκου σερβιρίσματος', 'Σαλόνι', 'daily', 7),
  ('Εσωτερικός καθαρισμός ψυγείων/καταψυκτών', 'Κουζίνα', 'weekly', 8),
  ('Καθαρισμός αποθήκης τροφίμων', 'Αποθήκη', 'weekly', 9),
  ('Βαθύς καθαρισμός εξοπλισμού μαγειρέματος', 'Κουζίνα', 'weekly', 10),
  ('Καθαρισμός ραφιών/ντουλαπιών αποθήκευσης', 'Αποθήκη', 'weekly', 11),
  ('Καθαρισμός σχαρών/φίλτρων λίπους φριτέζας', 'Κουζίνα', 'weekly', 12),
  ('Καθαρισμός απορροφητήρων/φίλτρων εξαερισμού', 'Κουζίνα', 'monthly', 13),
  ('Έλεγχος και καθαρισμός παγίδων εντόμων', 'Όλοι οι χώροι', 'monthly', 14),
  ('Καθαρισμός συστήματος κλιματισμού/εξαερισμού', 'Όλοι οι χώροι', 'monthly', 15)
) as v(name, area, frequency, sort_order)
where not exists (select 1 from cleaning_tasks);
