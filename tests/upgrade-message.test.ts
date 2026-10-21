import { expect,it,vi } from 'vitest';
import { mutationUserMessage } from '@/lib/errors/user-message';
it('shows the controlled upgrade requirement and preserves unsynced drafts',()=>{
  const log=vi.spyOn(console,'error').mockImplementation(()=>undefined);
  try{const message=mutationUserMessage({code:'PT426',status:426,message:'server refusal'},'Не удалось сохранить.');
    expect(message).toContain('Обновите приложение');expect(message).toContain('черновик');expect(message).toContain('Не очищайте несинхронизированную очередь');
  }finally{log.mockRestore();}
});
