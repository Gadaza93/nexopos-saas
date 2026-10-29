-- NexoPos · Insumos y recetas en la nube
--   · productos.tipo ('reventa' | 'preparado') y productos.receta ([{ insumoId, qty, unit }] por porción).
--     Un preparado no tiene stock propio: ventas_cantidades ya lo excluye del stock por movimientos.
--   · insumos: catálogo por negocio con su unidad de manejo; stock, mínimo y costo van en esa unidad.
--   · movimientos_insumos: cada caja sube la diferencia de lo que cambió localmente (ventas, compras, mermas,
--     ajustes, conteo) y el trigger la suma al stock. Las cajas nunca escriben el stock absoluto (salvo al crear).
--   · Las cajas no borran insumos (activo = false), para no dejar movimientos huérfanos.

alter table public.productos
  add column tipo text not null default 'reventa' check (tipo in ('reventa', 'preparado')),
  add column receta jsonb;

create table public.insumos (
  id text primary key,
  business_id text not null default public.get_business_id(),
  nombre text not null,
  unidad text not null default 'und' check (unidad in ('kg', 'g', 'lb', 'L', 'ml', 'und')),
  stock numeric not null default 0,
  min_stock numeric not null default 0,
  costo numeric not null default 0,
  costo_ultimo numeric,
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.movimientos_insumos (
  id text primary key,
  business_id text not null default public.get_business_id(),
  insumo_id text not null,
  delta numeric not null check (delta <> 0),
  motivo text not null default 'ajuste',
  created_at timestamptz not null default now()
);

create index insumos_negocio_idx on public.insumos (business_id, id);
create index movimientos_insumos_negocio_idx on public.movimientos_insumos (business_id, created_at desc);

alter table public.insumos enable row level security;
alter table public.movimientos_insumos enable row level security;

create policy insumos_select on public.insumos for select to authenticated
  using (business_id = (select public.get_business_id()));
create policy insumos_insert on public.insumos for insert to authenticated
  with check (business_id = (select public.get_business_id()));
create policy insumos_update on public.insumos for update to authenticated
  using (business_id = (select public.get_business_id())) with check (business_id = (select public.get_business_id()));
create policy movimientos_insumos_select on public.movimientos_insumos for select to authenticated
  using (business_id = (select public.get_business_id()));
create policy movimientos_insumos_insert on public.movimientos_insumos for insert to authenticated
  with check (business_id = (select public.get_business_id()));

revoke all on public.insumos, public.movimientos_insumos from anon, authenticated;
grant select, insert on public.insumos to authenticated;
-- Todas las columnas menos stock: el upsert del catálogo reescribe las que envía; el stock solo lo cambia el trigger
grant update (id, business_id, nombre, unidad, min_stock, costo, costo_ultimo, activo, created_at, updated_at) on public.insumos to authenticated;
grant select, insert on public.movimientos_insumos to authenticated;

create or replace function private.movimientos_insumos_aplicar()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.insumos
     set stock = stock + new.delta, updated_at = now()
   where id = new.insumo_id and business_id = new.business_id;
  return null;
end;
$$;
revoke execute on function private.movimientos_insumos_aplicar() from public, anon, authenticated;
create trigger movimientos_insumos_aplicar after insert on public.movimientos_insumos
  for each row execute function private.movimientos_insumos_aplicar();

-- Eliminar un negocio también borra sus insumos y movimientos
create or replace function public.admin_delete_negocio(p_negocio_id text, p_confirmacion text)
returns jsonb
language plpgsql
security definer
set search_path = ''
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

  delete from public.pedidos_activos     where business_id = p_negocio_id; get diagnostics v_n = row_count; v_res := v_res || jsonb_build_object('pedidos_activos', v_n);
  delete from public.ventas              where business_id = p_negocio_id; get diagnostics v_n = row_count; v_res := v_res || jsonb_build_object('ventas', v_n);
  delete from public.gastos              where business_id = p_negocio_id; get diagnostics v_n = row_count; v_res := v_res || jsonb_build_object('gastos', v_n);
  delete from public.mermas              where business_id = p_negocio_id; get diagnostics v_n = row_count; v_res := v_res || jsonb_build_object('mermas', v_n);
  delete from public.turnos_caja         where business_id = p_negocio_id; get diagnostics v_n = row_count; v_res := v_res || jsonb_build_object('turnos_caja', v_n);
  delete from public.movimientos_stock   where business_id = p_negocio_id; get diagnostics v_n = row_count; v_res := v_res || jsonb_build_object('movimientos_stock', v_n);
  delete from public.productos           where business_id = p_negocio_id; get diagnostics v_n = row_count; v_res := v_res || jsonb_build_object('productos', v_n);
  delete from public.proveedores         where business_id = p_negocio_id; get diagnostics v_n = row_count; v_res := v_res || jsonb_build_object('proveedores', v_n);
  delete from public.movimientos_insumos where business_id = p_negocio_id; get diagnostics v_n = row_count; v_res := v_res || jsonb_build_object('movimientos_insumos', v_n);
  delete from public.insumos             where business_id = p_negocio_id; get diagnostics v_n = row_count; v_res := v_res || jsonb_build_object('insumos', v_n);
  delete from public.recuperaciones_acceso where business_id = p_negocio_id;
  delete from auth.users
   where raw_app_meta_data ->> 'business_id' = p_negocio_id
     and coalesce(raw_app_meta_data ->> 'role', '') <> 'superadmin';
  get diagnostics v_n = row_count; v_res := v_res || jsonb_build_object('cuentas', v_n);
  delete from public.negocios where id = p_negocio_id;

  return v_res || jsonb_build_object('id', p_negocio_id);
end;
$$;

alter publication supabase_realtime add table public.insumos;
