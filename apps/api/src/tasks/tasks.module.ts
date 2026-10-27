import { Module } from '@nestjs/common';
import { TasksService } from './tasks.service';
import { TasksResolver } from './tasks.resolver';

@Module({
  providers: [TasksService, TasksResolver],
  exports: [TasksService],
})
export class TasksModule {}
