-- NexoPos · Stock por movimientos (28-10-2026)
-- Pegar completo en el SQL Editor de Supabase. Se puede ejecutar varias veces.
--
-- Antes cada caja subía el stock ABSOLUTO de cada producto y ganaba la última: dos cajas vendiendo sin internet
-- dejaban la nube con el número equivocado. Ahora el servidor suma y resta:
--   · Venta nueva o editada → el trigger de ventas descuenta la diferencia de cantidades por producto.
--   · Compras, mermas, ajustes, conteos y altas de stock → la caja sube un movimiento (delta) a movimientos_stock.
--   · Cada movimiento suma su delta a productos.stock en una sola operación atómica.
-- Reintentar es seguro: el id del movimiento es la llave (on conflict do nothing) y volver a subir una venta igual
-- no cambia sus cantidades (diferencia 0). Borrar una venta no devuelve stock: si el usuario elige devolverlo, la
-- caja sube el movimiento. Las cajas con la versión anterior siguen funcionando (suben el stock absoluto).

-- 1. Movimientos (solo se insertan; nadie los edita ni borra salvo admin_delete_negocio)
create table if not exists public.movimientos_stock (
  id text primary key,
  business_id text not null,
  producto_id text not null,
  delta numeric not null check (delta <> 0),
  motivo text not null default 'ajuste',
  created_at timestamptz not null default now()
);
create index if not exists movimientos_stock_negocio_idx on public.movimientos_stock (business_id, created_at desc);

alter table public.movimientos_stock enable row level security;
drop policy if exists authenticated_select_movimientos_stock on public.movimientos_stock;
create policy authenticated_select_movimientos_stock on public.movimientos_stock
  for select to authenticated using (business_id = (select public.get_business_id()));
drop policy if exists authenticated_insert_movimientos_stock on public.movimientos_stock;
create policy authenticated_insert_movimientos_stock on public.movimientos_stock
  for insert to authenticated with check (business_id = (select public.get_business_id()));
revoke all on public.movimientos_stock from anon, authenticated;
grant select, insert on public.movimientos_stock to authenticated;

-- 2. Cada movimiento suma su delta al producto del mismo negocio (productos.id es único global: se filtra el negocio)
create or replace function public.movimientos_stock_aplicar()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.productos
     set stock = stock + new.delta, updated_at = now()
   where id = new.producto_id and business_id = new.business_id;
  return null;
end;
$$;
revoke all on function public.movimientos_stock_aplicar() from public, anon, authenticated;
drop trigger if exists movimientos_stock_aplicar on public.movimientos_stock;
create trigger movimientos_stock_aplicar after insert on public.movimientos_stock
  for each row execute function public.movimientos_stock_aplicar();

-- 3. Cantidades por producto de los ítems de una venta (productId o id; qty no numérica cuenta 0: nunca falla)
create or replace function public.ventas_cantidades(p_items jsonb)
returns table (producto_id text, cantidad numeric)
language sql
immutable
set search_path = ''
as $$
  select coalesce(it ->> 'productId', it ->> 'id'),
         sum(case when jsonb_typeof(it -> 'qty') = 'number' then (it ->> 'qty')::numeric
                  when (it ->> 'qty') ~ '^-?[0-9]+(\.[0-9]+)?$' then (it ->> 'qty')::numeric
                  else 0 end)
  from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end) as it
  where coalesce(it ->> 'productId', it ->> 'id') is not null
  group by 1;
$$;
revoke all on function public.ventas_cantidades(jsonb) from public, anon, authenticated;

-- 4. Venta insertada o con ítems editados: un movimiento por producto con la diferencia (vendido de más → negativo)
create or replace function public.ventas_stock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.movimientos_stock (id, business_id, producto_id, delta, motivo)
  select 'venta:' || new.id || ':' || d.producto_id || ':' || gen_random_uuid(),
         new.business_id, d.producto_id, d.delta,
         case when tg_op = 'INSERT' then 'venta' else 'venta editada' end
  from (
    select coalesce(n.producto_id, o.producto_id) as producto_id,
           coalesce(o.cantidad, 0) - coalesce(n.cantidad, 0) as delta
    from public.ventas_cantidades(new.items) n
    full join public.ventas_cantidades(case when tg_op = 'UPDATE' then old.items end) o
      on o.producto_id = n.producto_id
  ) d
  where d.delta <> 0
    and exists (select 1 from public.productos p where p.id = d.producto_id and p.business_id = new.business_id);
  return null;
end;
$$;
revoke all on function public.ventas_stock() from public, anon, authenticated;
drop trigger if exists ventas_stock on public.ventas;
create trigger ventas_stock after insert or update of items on public.ventas
  for each row execute function public.ventas_stock();

-- 5. Eliminar negocio: también sus movimientos (regla: toda tabla con business_id entra aquí)
create or replace function public.admin_delete_negocio(p_negocio_id text, p_confirmacion text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_res jsonb := '{}'::jsonb;
  v_n int;
begin
  if coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'superadmin' then
    raise exception 'Acceso no autorizado' using errcode = '42501';
  end if;
  if p_negocio_id is null or trim(p_negocio_id) = '' or p_confirmacion is distinct from p_negocio_id then
    raise exception 'La confirmación no coincide con el ID del negocio' using errcode = '22023';
  end if;
  if not exists (select 1 from public.negocios where id = p_negocio_id) then
    raise exception 'El negocio "%" no existe', p_negocio_id using errcode = 'P0002';
  end if;

  delete from public.pedidos_activos where business_id = p_negocio_id; get diagnostics v_n = row_count; v_res := v_res || jsonb_build_object('pedidos_activos', v_n);
  delete from public.ventas          where business_id = p_negocio_id; get diagnostics v_n = row_count; v_res := v_res || jsonb_build_object('ventas', v_n);
  delete from public.gastos          where business_id = p_negocio_id; get diagnostics v_n = row_count; v_res := v_res || jsonb_build_object('gastos', v_n);
  delete from public.mermas          where business_id = p_negocio_id; get diagnostics v_n = row_count; v_res := v_res || jsonb_build_object('mermas', v_n);
  delete from public.turnos_caja     where business_id = p_negocio_id; get diagnostics v_n = row_count; v_res := v_res || jsonb_build_object('turnos_caja', v_n);
  delete from public.movimientos_stock where business_id = p_negocio_id; get diagnostics v_n = row_count; v_res := v_res || jsonb_build_object('movimientos_stock', v_n);
  delete from public.productos       where business_id = p_negocio_id; get diagnostics v_n = row_count; v_res := v_res || jsonb_build_object('productos', v_n);
  delete from public.proveedores     where business_id = p_negocio_id; get diagnostics v_n = row_count; v_res := v_res || jsonb_build_object('proveedores', v_n);
  delete from public.recuperaciones_acceso where business_id = p_negocio_id;
  delete from auth.users
   where raw_app_meta_data ->> 'business_id' = p_negocio_id
     and coalesce(raw_app_meta_data ->> 'role', '') <> 'superadmin';
  get diagnostics v_n = row_count; v_res := v_res || jsonb_build_object('cuentas', v_n);
  delete from public.negocios where id = p_negocio_id;

  return v_res || jsonb_build_object('id', p_negocio_id);
end;
$$;
revoke all on function public.admin_delete_negocio(text, text) from public, anon;
grant execute on function public.admin_delete_negocio(text, text) to authenticated;

-- Verificación (solo lectura)
-- select tgname, tgrelid::regclass from pg_trigger where tgname in ('ventas_stock', 'movimientos_stock_aplicar');
