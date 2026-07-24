import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  MonitoredBrand,
  MonitoredBrandSchema,
} from './schemas/monitored-brand.schema';
import { BrandsService } from './brands.service';
import { BrandsController } from './brands.controller';
import { WorkspacesModule } from '../workspaces/workspaces.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: MonitoredBrand.name, schema: MonitoredBrandSchema },
    ]),
    forwardRef(() => WorkspacesModule),
  ],
  providers: [BrandsService],
  controllers: [BrandsController],
  exports: [BrandsService, MongooseModule],
})
export class BrandsModule {}
