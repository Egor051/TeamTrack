import { Input, type InputProps } from '@/components/ui/input';
export function Textarea(props: InputProps) { return <Input {...props} multiline numberOfLines={4} />; }
