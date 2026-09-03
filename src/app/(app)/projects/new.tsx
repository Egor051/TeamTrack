import { useState } from 'react';
import { router } from 'expo-router';
import { Screen } from '@/components/ui/screen';
import { ThemedText } from '@/components/ui/text';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ErrorMessage } from '@/components/ui/error-message';
import { createProject } from '@/features/projects/projects';
export default function NewProjectScreen() { const [name,setName]=useState(''); const [description,setDescription]=useState(''); const [busy,setBusy]=useState(false); const [error,setError]=useState(''); async function submit(){if(!name.trim()) return setError('Введите название проекта'); setBusy(true); setError(''); try{const id=await createProject(name.trim(),description.trim()); router.replace(`/projects/${id}` as never);}catch(e){setError(e instanceof Error?e.message:'Не удалось создать проект');}finally{setBusy(false)}} return <Screen scrollable><ThemedText type="title">Новый проект</ThemedText><Input label="Название" placeholder="Название проекта" value={name} onChangeText={setName}/><Input label="Описание" placeholder="Необязательно" value={description} onChangeText={setDescription} multiline/><ErrorMessage message={error} type="auth"/><Button loading={busy} onPress={submit}>Создать</Button><Button variant="outline" onPress={()=>router.back()}>Отмена</Button></Screen> }
