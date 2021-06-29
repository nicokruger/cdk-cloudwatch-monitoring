import { QuietTimeDef } from './quiet';
import { DemoParameters } from './alarms'

enum Version {
  v1 = "1",
  v2 = "2",
}

type Customer = {
  opname: string;
  ip: string;
  port: string;
  database: string;
  version: Version;

  demoParams: DemoParameters;

  quietTime?: QuietTimeDef;
}


const customers: Customer[] = [
  {
    opname: "Customer 1",
    ip: "database-1.cv73mlur6hox.af-south-1.rds.amazonaws.com",
    port: "5432",
    database: "postgres",
    version: Version.v2,
    demoParams: {
      threshold: 5,
      enableAnomalyDetection: true
    },
  },
  {
    opname: "Customer 2",
    ip: "database-1.cv73mlur6hox.af-south-1.rds.amazonaws.com",
    port: "5432",
    database: "postgres",
    version: Version.v1,
    demoParams: {
      threshold: 5
    },
    quietTime: {
      startHourUTC: "0",
      endHourUTC: "4"
      
    }
  }
]

export {
  Version,
  Customer,
  customers
}
