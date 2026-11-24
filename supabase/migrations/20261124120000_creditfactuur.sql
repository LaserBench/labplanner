-- Creditfacturen: kind = 'credit', bedragen negatief, verwijzing naar de originele factuur.
alter table public.invoices add column if not exists credit_of text;
