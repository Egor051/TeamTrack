// Test fixtures load the baseline before a NEW versioned edit. Explicit
// preconditions are never replaced, so stale-draft/CAS assertions stay intact.
// Legacy-contract tests call client.rpc directly and assert PT426 instead.
export async function fixtureCas(client,name,args={}){
 const value=async q=>{const r=await q;if(r.error)throw r.error;return r.data;};
 let expected={};
 if(['set_task_item_comment','set_task_item_percentage','set_task_item_state','update_task_item'].includes(name)&&!('p_expected_version'in args)){
  const row=await value(client.from('task_items').select('sync_version').eq('id',args.p_task_item_id).maybeSingle());
  expected={p_expected_version:row?.sync_version??1};
  if(name==='update_task_item'&&('p_description'in args||'p_position'in args))expected={...expected,p_description:args.p_description??null,p_position:args.p_position??null};
 }
 if(name==='update_project'&&!('p_expected_name'in args)){
  const row=await value(client.from('projects').select('name,description').eq('id',args.p_project_id).maybeSingle());
  expected={p_expected_name:row?.name??'',p_expected_description:row?.description??'',p_description:args.p_description??row?.description??''};
 }
 if(name==='update_task'&&!('p_expected_title'in args)){
  const row=await value(client.from('tasks').select('title,description').eq('id',args.p_task_id).maybeSingle());
  expected={p_expected_title:row?.title??'',p_expected_description:row?.description??'',p_description:args.p_description??row?.description??''};
 }
 if(name==='update_task_template'&&!('p_expected_name'in args)){
  const row=await value(client.rpc('get_task_template',{p_template_id:args.p_template_id}));
  expected={p_expected_name:row?.name??'',p_expected_description:row?.description??'',p_description:args.p_description??row?.description??''};
 }
 if(name==='update_task_template_item'&&!('p_expected_title'in args)){
  let row;
  for(const template of await value(client.rpc('list_task_templates'))){
   row=(await value(client.rpc('list_task_template_items',{p_template_id:template.id}))).find(item=>item.id===args.p_item_id);if(row)break;
  }
  expected={p_expected_title:row?.title??'',p_expected_description:row?.description??'',p_description:args.p_description??row?.description??''};
 }
 if(name==='update_my_profile'&&!('p_expected_display_name'in args)){
  const row=await value(client.rpc('get_my_profile'));expected={p_expected_display_name:row.display_name};
 }
 return client.rpc(name,{...expected,...args});
}
