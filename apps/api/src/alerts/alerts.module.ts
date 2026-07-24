import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Alert, AlertSchema } from './schemas/alert.schema';
import { AlertsService } from './alerts.service';
import { AlertsController } from './alerts.controller';
import { WorkspacesModule } from '../workspaces/workspaces.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Alert.name, schema: AlertSchema }]),
    forwardRef(() => WorkspacesModule),
  ],
  providers: [AlertsService],
  controllers: [AlertsController],
  exports: [AlertsService, MongooseModule],
})
export class AlertsModule {}
