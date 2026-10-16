import { useLocalSearchParams } from 'expo-router';
import { ProjectMembersPanel } from '@/features/projects/project-members-panel';
export default function MembersScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ProjectMembersPanel key={id} projectId={id} />;
}
