// Capacity for disposable fixtures, NOT production sizing. Boundary tests
// replace these values with tiny budgets and exercise rejection/rollback.
export const receiptTestPolicySql = `do $$begin
  if to_regclass('private.client_operation_policy') is not null then
    update private.client_operation_policy set max_receipts=1000000,max_logical_bytes=17179869184,
      max_request_bytes=1048576,max_result_bytes=1048576,new_per_minute=100000 where singleton;
  end if;
  if to_regclass('private.client_operation_window_policy') is not null then
    update private.client_operation_window_policy set admission_seconds=86400,replay_seconds=7776000,
      max_receipts=1000000,max_logical_bytes=17179869184,max_global_receipts=10000000,max_global_bytes=171798691840,
      max_request_bytes=1048576,max_result_bytes=1048576,new_per_minute=100000 where singleton;
  end if;
end $$;`;
