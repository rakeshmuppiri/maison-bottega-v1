-- Run this once in Supabase → SQL Editor.

create extension if not exists pgcrypto;

create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  customer_name text not null default '',
  customer_email text not null default '',
  customer_phone text default '',
  items jsonb not null,               -- [{ id, name, price, qty }, ...]
  subtotal numeric not null,          -- INR, recomputed server-side
  currency text not null default 'INR',
  razorpay_order_id text,
  razorpay_payment_id text,
  status text not null default 'pending'   -- pending | paid | failed
);

-- Row Level Security is ON with NO policies defined.
-- That means the table is unreachable via the public anon key —
-- only your Edge Functions (using the service_role key) can read/write it.
-- This keeps customer emails/phone numbers private by default.
alter table orders enable row level security;
