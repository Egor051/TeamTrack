-- Keep project lifecycle metadata aligned with the hard-delete/history model.
comment on table public.projects is
    $$Archiving (status='archived' + archived_at) is the normal removal flow. Hard DELETE is permitted only for archived projects through the authorized hard_delete_project() RPC. Historical audit/item history is preserved independently of the project row.$$;
