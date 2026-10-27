import { Module } from '@nestjs/common';
import { CalendarService } from './calendar.service';
import { CalendarResolver } from './calendar.resolver';

@Module({
  providers: [CalendarService, CalendarResolver],
  exports: [CalendarService],
})
export class CalendarModule {}
