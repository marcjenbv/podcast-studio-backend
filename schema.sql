-- Run this in your Supabase SQL editor

create table if not exists users (
  id                      uuid primary key default gen_random_uuid(),
  email                   text unique not null,
  password_hash           text not null,
  subscription_status     text not null default 'inactive',
  subscription_plan       text default 'none',
  subscription_end        timestamptz,
  stripe_customer_id      text unique,
  stripe_subscription_id  text,
  minutes_used            int  not null default 0,
  minutes_topup           int  not null default 0,
  free_minutes_used       int  not null default 0,
  period_start            timestamptz default now(),
  created_at              timestamptz default now()
);

alter table users add column if not exists subscription_plan  text default 'none';
alter table users add column if not exists minutes_used       int  not null default 0;
alter table users add column if not exists minutes_topup      int  not null default 0;
alter table users add column if not exists free_minutes_used  int  not null default 0;
alter table users add column if not exists period_start       timestamptz default now();

create table if not exists podcasts (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references users(id) on delete cascade,
  topic        text not null,
  language     text default 'en',
  tone         text default 'Debate',
  duration     int  default 15,
  participants jsonb,
  turns        jsonb,
  created_at   timestamptz default now()
);

create table if not exists topup_purchases (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid references users(id) on delete cascade,
  minutes_added            int not null,
  amount_cents             int not null,
  stripe_payment_intent_id text,
  created_at               timestamptz default now()
);

create index if not exists podcasts_user_id_idx      on podcasts(user_id);
create index if not exists users_email_idx           on users(email);
create index if not exists users_stripe_customer_idx on users(stripe_customer_id);

alter table users            disable row level security;
alter table podcasts         disable row level security;
alter table topup_purchases  disable row level security;
