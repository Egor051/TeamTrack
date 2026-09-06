import { useState } from 'react'; import { StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@/components/ui/screen';
import { PageHeader } from '@/components/ui/page-header';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ErrorMessage } from '@/components/ui/error-message';
import { ThemedText } from '@/components/ui/text';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/features/auth/AuthProvider';
import { colors, spacing } from '@/components/ui/theme';
import { userMessage } from '@/lib/errors/user-message';
import { useTheme, type ThemeMode } from '@/components/ui/theme-provider';

export default function ProfileScreen(){const{state,signOut,updateProfile}=useAuth();const theme=useTheme();const[busy,setBusy]=useState(false);const[error,setError]=useState('');const[editing,setEditing]=useState(false);const[name,setName]=useState(state.profile?.display_name||'');async function save(){setBusy(true);setError('');try{await updateProfile(name);setEditing(false)}catch(e){setError(userMessage(e,'Не удалось сохранить ник.'))}finally{setBusy(false)}}async function logout(){setBusy(true);setError('');try{await signOut()}catch(e){setError(userMessage(e,'Не удалось завершить сеанс.'))}finally{setBusy(false)}}return <Screen centerContent={false} maxWidth={620}><PageHeader title="Профиль" onBack={()=>router.back()}/><Card><View style={styles.avatar}><ThemedText type="h1">{(state.profile?.display_name||state.user?.email||'?').slice(0,1).toUpperCase()}</ThemedText></View>{editing?<><Input label="Ник" value={name} onChangeText={setName} autoFocus/><View style={styles.actions}><Button loading={busy} disabled={busy||!name.trim()} onPress={()=>void save()}>Сохранить</Button><Button variant="outline" disabled={busy} onPress={()=>{setEditing(false);setName(state.profile?.display_name||'')}}>Отмена</Button></View></>:<><ThemedText type="h2">{state.profile?.display_name||'Пользователь'}</ThemedText><Button size="sm" variant="outline" onPress={()=>setEditing(true)}>Изменить ник</Button></>}<ThemedText type="small">{state.user?.email}</ThemedText><Badge tone="success">Аккаунт активен</Badge></Card><Card><ThemedText type="h2">Тема</ThemedText><View style={styles.actions}>{(['light','dark','system'] as ThemeMode[]).map((mode)=><Button key={mode} size="sm" variant={theme.mode===mode?'primary':'outline'} onPress={()=>theme.setMode(mode)}>{mode==='light'?'Светлая':mode==='dark'?'Тёмная':'Системная'}</Button>)}</View></Card>{error?<ErrorMessage message={error} type="auth"/>:null}<Button variant="destructive" loading={busy} disabled={busy} onPress={logout}>Выйти</Button></Screen>}
const styles=StyleSheet.create({avatar:{width:64,height:64,borderRadius:32,backgroundColor:colors.primarySoft,alignItems:'center',justifyContent:'center',marginBottom:spacing.md},actions:{flexDirection:'row',flexWrap:'wrap',gap:spacing.sm}});
