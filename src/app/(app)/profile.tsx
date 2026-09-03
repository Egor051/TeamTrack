import { useState } from 'react'; import { StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@/components/ui/screen';
import { PageHeader } from '@/components/ui/page-header';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ErrorMessage } from '@/components/ui/error-message';
import { ThemedText } from '@/components/ui/text';
import { useAuth } from '@/features/auth/AuthProvider';
import { colors, spacing } from '@/components/ui/theme';
import { userMessage } from '@/lib/errors/user-message';

export default function ProfileScreen(){const{state,signOut}=useAuth();const[busy,setBusy]=useState(false);const[error,setError]=useState('');async function logout(){setBusy(true);setError('');try{await signOut()}catch(e){setError(userMessage(e,'Не удалось завершить сеанс.'))}finally{setBusy(false)}}return <Screen centerContent={false} maxWidth={620}><PageHeader title="Профиль" onBack={()=>router.back()}/><Card><View style={styles.avatar}><ThemedText type="h1">{(state.profile?.display_name||state.user?.email||'?').slice(0,1).toUpperCase()}</ThemedText></View><ThemedText type="h2">{state.profile?.display_name||'Пользователь'}</ThemedText><ThemedText type="small">{state.user?.email}</ThemedText><Badge tone="success">Аккаунт активен</Badge></Card>{error?<ErrorMessage message={error} type="auth"/>:null}<Button variant="destructive" loading={busy} onPress={logout}>Выйти</Button></Screen>}
const styles=StyleSheet.create({avatar:{width:64,height:64,borderRadius:32,backgroundColor:colors.primarySoft,alignItems:'center',justifyContent:'center',marginBottom:spacing.md}});
