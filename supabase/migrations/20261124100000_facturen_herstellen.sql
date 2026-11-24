-- Herstelacties voor facturen (alleen info@nmept.com).
-- 1. undo_payment_overview: export ongedaan maken; facturen gaan terug naar 'geaccepteerd'.
-- 2. delete_accepted_invoice: geaccepteerde (nog niet verstuurde) factuur verwijderen;
--    latere factuurnummers van dat jaar schuiven één op, zodat er geen gat in de nummering valt.
--    Kan niet meer als er al een latere factuur is verstuurd.

create or replace function public.undo_payment_overview(p_ref text) returns int
language plpgsql security invoker as $$
declare v_year int; v_seq int; v_n int;
begin
  if not public.is_admin() then raise exception 'Geen toegang'; end if;
  if not exists (select 1 from public.payment_overviews where ref = p_ref) then
    raise exception 'Betaaloverzicht % niet gevonden', p_ref;
  end if;
  v_year := left(p_ref, 4)::int;
  v_seq  := substr(p_ref, 5)::int;

  update public.invoices
     set status = 'geaccepteerd', payment_ref = null, sent_at = null, updated_at = now()
   where payment_ref = p_ref;
  get diagnostics v_n = row_count;

  delete from public.payment_overviews where ref = p_ref;

  -- referentie vrijgeven als dit de laatst uitgegeven was
  update public.counters set value = value - 1
   where key = 'payref' and year = v_year and value = v_seq;

  return v_n;
end $$;
grant execute on function public.undo_payment_overview(text) to authenticated;

create or replace function public.delete_accepted_invoice(p_id text) returns int
language plpgsql security invoker as $$
declare v_num text; v_status text; v_year text; v_seq int; r record; v_moved int := 0;
begin
  if not public.is_admin() then raise exception 'Geen toegang'; end if;

  select number, status into v_num, v_status from public.invoices where id = p_id for update;
  if not found then raise exception 'Factuur niet gevonden'; end if;
  if v_status <> 'geaccepteerd' or v_num is null then
    raise exception 'Alleen geaccepteerde facturen kunnen worden verwijderd';
  end if;

  v_year := left(v_num, 4);
  v_seq  := substr(v_num, 7)::int;

  if exists (select 1 from public.invoices
              where status = 'verstuurd' and number is not null
                and left(number, 4) = v_year and substr(number, 7)::int > v_seq) then
    raise exception 'Er is al een latere factuur verstuurd; de nummers kunnen niet meer opschuiven';
  end if;

  delete from public.invoices where id = p_id;

  -- latere nummers één omlaag (oplopend, zodat er geen dubbele nummers ontstaan)
  for r in select id, number from public.invoices
            where number is not null and left(number, 4) = v_year and substr(number, 7)::int > v_seq
            order by substr(number, 7)::int loop
    update public.invoices
       set number = left(r.number, 6) || lpad((substr(r.number, 7)::int - 1)::text, 4, '0'),
           updated_at = now()
     where id = r.id;
    v_moved := v_moved + 1;
  end loop;

  update public.counters set value = value - 1 where key = 'invoice' and year = v_year::int;

  return v_moved;
end $$;
grant execute on function public.delete_accepted_invoice(text) to authenticated;
