import * as iam from '@aws-cdk/aws-iam';
import { join } from 'path';
import { Vpc } from '@aws-cdk/aws-ec2';
import * as s3 from '@aws-cdk/aws-s3';
import * as cdk from '@aws-cdk/core';
import * as sfn from '@aws-cdk/aws-stepfunctions';
import * as tasks from '@aws-cdk/aws-stepfunctions-tasks';
import * as lambda from '@aws-cdk/aws-lambda';
import * as dynamodb from '@aws-cdk/aws-dynamodb';
import { queries } from './queries';
import { Rule, Schedule, RuleTargetInput } from '@aws-cdk/aws-events';
import { LambdaFunction, SfnStateMachine } from '@aws-cdk/aws-events-targets';
import { Kpi, KpiMonitor, CreateAlarms, DemoAlarms, createQuietTimeAlarm } from './alarms';
import { QuietTimeDef } from './quiet';
import * as cloudwatch from '@aws-cdk/aws-cloudwatch';
import { customers, Customer } from './customers';
import { groupBy } from 'lodash';


const NAMESPACE = 'demo-namespace';

// for graphs
const kpiTypeOrder = [
  [Kpi.DEMO, "Demo"]
];


type customerAlarmDefinitions = {
  customer: string,
  createAlarms: CreateAlarms[]
  quietTime?: QuietTimeDef
}

type CustomerQuietTime = {
  quietTime: QuietTimeDef;
  customer: string;
}

type AlarmsAndKpis = {
  alarms: cloudwatch.CompositeAlarm[];
  kpis: KpiMonitor[];
  customer: string;
}


export class OpsviewSqlStack extends cdk.Stack {
  quietTimes: CustomerQuietTime[] = [];
  fetchSchedule: Rule;
  fetchLongSchedule: Rule;
  addedTargets: number;
  addedLongTargets: number;
  addedSchedules: number;
  addedLongSchedules: number;
  loadingStatusTable: dynamodb.ITable;

  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.addedTargets = 0;
    this.addedSchedules = 1;

    this.loadingStatusTable = new dynamodb.Table(this, 'LoadingStatus', {
      partitionKey: {
        name: 'pk',
        type: dynamodb.AttributeType.STRING
      },
      sortKey: {
        name: 'sk',
        type: dynamodb.AttributeType.STRING
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST
    });

/*
    const vpc = Vpc.fromVpcAttributes(this, 'ImportVpc', {
      vpcId: 'vpc-xxxx',
      availabilityZones: ['a','b','c'],
      publicSubnetIds: [],
      privateSubnetIds: ['subnet1', 'subnet2', 'subnet3']
    });
*/

    const dataBucket = new s3.Bucket(this, 'DataBucket');

    const cloudwatchPolicyStatement = new iam.PolicyStatement();
    cloudwatchPolicyStatement.addActions('cloudwatch:*');
    cloudwatchPolicyStatement.addResources('*');


    const manageQuietTimeLambda = new lambda.Function(this, 'QuietTimeManager', {
      runtime: lambda.Runtime.NODEJS_14_X,
      code: lambda.Code.fromAsset(join(__dirname, '../quiet-time/')),
      handler: 'index.handler',
      environment: {
        NAMESPACE
      }
    });
    manageQuietTimeLambda.addToRolePolicy(cloudwatchPolicyStatement);

    const customerLambdaRole = new iam.Role(this, 'LambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaVPCAccessExecutionRole"),
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole")
      ]
    });
    customerLambdaRole.addToPolicy(cloudwatchPolicyStatement);
    dataBucket.grantReadWrite(customerLambdaRole);

    const runnerCode = lambda.Code.fromAsset(join(__dirname, '../query-runner/'));
    const alarms: cloudwatch.CompositeAlarm[] = [];
    const kpis: KpiMonitor[] = [];
    const dataAlarmsByCustomer: { [customer: string] : cloudwatch.Alarm } = {};
    const quietTimeAlarmsByCustomer: { [customer: string] : cloudwatch.Alarm } = {};
    const alarmsByCustomer: { [customer: string]: cloudwatch.CompositeAlarm[]; } = {};


    for (const customer of customers) {

      const {
        opname,
        ip,
        port,
        database,
      } = customer;

      // we create a lambda per customer - you could also do this with one lambda function
      // created just above but i find it easier for debugging to do it like this.
      const runQueryFunction = new lambda.Function(this, 'opsv-query-' + fixName(opname), {
        handler: 'index.handler',
        code: runnerCode,
        timeout: cdk.Duration.minutes(15),
        //vpc,
        role:customerLambdaRole,
        runtime: lambda.Runtime.NODEJS_14_X,
        environment: {
          BUCKET: dataBucket.bucketName,
          POSTGRES_USER: process.env.POSTGRES_USER ?? 'postgres',
          POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD ?? '<specify password>',
          NAMESPACE
        }
      });

      const quietTimeAlarm = createQuietTimeAlarm(this, opname, NAMESPACE);
      quietTimeAlarmsByCustomer[opname] = quietTimeAlarm;


      // get the queries to setup in the state machine
      const customerTags = makeTags(customer);
      const opcoQueries = queries.filter( ({tags, versions}) => {
        return tags.some( tag => customerTags.includes(tag) ) && versions.some( v => customer.version == v );
      });

      const stepfunction_tasks: tasks.LambdaInvoke[] = [];
      for (const {query,name,description,cloudwatchDimension} of opcoQueries) {

        const runQuery = new tasks.LambdaInvoke(this, `${name} [${fixName(opname)}]`, {
          comment: description,
          lambdaFunction: runQueryFunction,
          resultPath: '$',
          payload: sfn.TaskInput.fromObject({
            queryName:name,
            query,
            opname,
            ip,
            database,
            port,
            cloudwatchDimension,
          })
        })

        stepfunction_tasks.push(runQuery);

      }


      // create a parallel branch to run all the queries
      let runQueries = new sfn.Parallel(this, 'Run Queries: ' + opname);
      for (const def of stepfunction_tasks) {
        runQueries = runQueries.branch(def);
      }

      const customerStateMachine = this.createStateMachine(runQueries, customer);

      const shortSfnTaskTarget = new SfnStateMachine(customerStateMachine);
      const fetchSchedule = this.getShortFetchSchedule();
      fetchSchedule.addTarget(shortSfnTaskTarget);


      const stepFunctionAlarm = this.makeStepFunctionAlarms(opname, customerStateMachine);
      dataAlarmsByCustomer[opname] = stepFunctionAlarm;

      const {alarms: theseAlarms, kpis: theseKpis} = this.createAlarms(stepFunctionAlarm, quietTimeAlarm, customer);
      alarmsByCustomer[customer.opname] = theseAlarms;

      for (const alarm of theseAlarms) {
        alarms.push(alarm);
      }

      for (const kpi of theseKpis) {
        kpis.push(kpi);
      }

    }

    this.manageQuietTime(this.quietTimes, manageQuietTimeLambda);

    this.createDashboard(dataAlarmsByCustomer, kpis, alarmsByCustomer);
    this.createCustomerDashboards(kpis, alarmsByCustomer, dataAlarmsByCustomer, quietTimeAlarmsByCustomer);

  }

  createStateMachine(runQueries: sfn.Parallel, { opname, version }: Customer): sfn.StateMachine {
      const pk = '#LOAD#' + opname;
      const sk = '#LOAD#';

      const getCustomerAlreadyRunning = new tasks.DynamoGetItem(this, 'Get Busy: ' + opname, {
        table: this.loadingStatusTable,
        resultPath: '$.IsBusy',
        key: {
          pk: tasks.DynamoAttributeValue.fromString(pk),
          sk: tasks.DynamoAttributeValue.fromString(sk)
        }
      })

      const addCustomerRunningRecord = new tasks.DynamoPutItem(this, 'Mark Busy: ' + opname, {
        table: this.loadingStatusTable,
        resultPath: sfn.JsonPath.DISCARD,
        item: {
          pk: tasks.DynamoAttributeValue.fromString(pk),
          sk: tasks.DynamoAttributeValue.fromString(sk)
        }
      });

      const deleteCustomerRunningRecord = new tasks.DynamoDeleteItem(this, 'Unmark Busy: ' + opname, {
        table: this.loadingStatusTable,
        resultPath: sfn.JsonPath.DISCARD,
        key: {
          pk: tasks.DynamoAttributeValue.fromString(pk),
          sk: tasks.DynamoAttributeValue.fromString(sk)
        }
      });

    runQueries.addCatch(deleteCustomerRunningRecord);

    // setup run definition - when not already running
    const runDefinition = addCustomerRunningRecord
              .next(runQueries)
              .next(deleteCustomerRunningRecord)


    const definition = getCustomerAlreadyRunning
      .next(
        new sfn.Choice(this, 'Check If Busy: ' + opname)
          .when(
            // if already running
            sfn.Condition.isPresent('$.IsBusy.Item.pk'), new sfn.Fail(this, 'Fail Already Busy: ' + opname, {
              cause: 'Already Busy',
              error: 'Busy record found in dynamo table'
            })
          )
        .otherwise(
          runDefinition
          .next(new sfn.Choice(this, 'Check if Error: ' + opname)
            .when(
              sfn.Condition.isPresent('$.Error'), new sfn.Fail(this, 'Failed: ' + opname, {
                cause: sfn.JsonPath.stringAt('$.Error.Cause'),
                error: sfn.JsonPath.stringAt('$.Error.Error')
              })
            )
            .otherwise(
              new sfn.Succeed(this, 'Done: ' + opname)
            )
          )
        )
      )

    const stateMachine = new sfn.StateMachine(this, `${opname} v${version}`, {
      stateMachineName:`${fixName(opname)}-(v${version})`,
      definition
    });

    return stateMachine;
 }

  createAlarms(statemachineFailedAlarm: cloudwatch.Alarm,
               quietTimeAlarm: cloudwatch.Alarm,
               incustomer: Customer,
               ): AlarmsAndKpis {
    const alarms: cloudwatch.CompositeAlarm[] = [];
    const kpis: KpiMonitor[] = [];

    const {
      customer,
      createAlarms,
      quietTime
    } = this.createOperatorAlarmDefinition(incustomer);

    if (quietTime) {
      this.quietTimes.push({quietTime,customer});
    }

    createAlarms.forEach( (alarmGroup: CreateAlarms) => {

      const newKpiChecks = alarmGroup.createAlarms(this, NAMESPACE, customer);

      for (const inneralarm of newKpiChecks.alarms) {
        let alarmRule;
        if (inneralarm.disableDuringQuietTime) {
          alarmRule = cloudwatch.AlarmRule.allOf(
            cloudwatch.AlarmRule.not(statemachineFailedAlarm),
            cloudwatch.AlarmRule.not(quietTimeAlarm),
            inneralarm.alarm
          );
        } else {
          alarmRule = cloudwatch.AlarmRule.allOf(
            cloudwatch.AlarmRule.not(statemachineFailedAlarm),
            inneralarm.alarm
          );
        }

        const alarm = new cloudwatch.CompositeAlarm(this, `${fixName(customer)}-C-${inneralarm.name}`, {
          compositeAlarmName: `${inneralarm.name}`,
          alarmRule
        });

        alarms.push(alarm);


        (alarm.node.defaultChild as cloudwatch.CfnAlarm).alarmDescription;

      }

      for (const innerKpi of newKpiChecks.kpis) {
        kpis.push(innerKpi);
      }
    });

    return {
      alarms,
      kpis,
      customer:incustomer.opname
    };

  }

  createDashboard(dataAlarmsByCustomer: { [customer: string]: cloudwatch.Alarm },
                  kpis: KpiMonitor[],
                  alarmsByCustomer: { [customer: string]: cloudwatch.CompositeAlarm[] }) {

    const width = 24;

    const statusAlarms = this.createCustomerStatusAlarms(alarmsByCustomer, dataAlarmsByCustomer);

    const dataLoadMetrics: (cloudwatch.Metric|cloudwatch.MathExpression)[] = Object.keys(dataAlarmsByCustomer).map( (customer) => {
      const alarm = dataAlarmsByCustomer[customer];
      return (alarm.metric as cloudwatch.Metric).with({
        statistic: "maximum",
        label: customer
      });;
    });

    const overviewDashboard = new cloudwatch.Dashboard(this, 'Overview', {
      dashboardName: 'Overview'
    });
    overviewDashboard.addWidgets(
      new cloudwatch.AlarmStatusWidget({
        title: 'Data Loading Status',
        alarms: Object.values(dataAlarmsByCustomer),
        width,
        height: 4
      })
    );

    overviewDashboard.addWidgets(
      new cloudwatch.AlarmStatusWidget({
        title: 'Customer Status',
        width,
        alarms: statusAlarms,
        height:4
      })
    )

    for (const customer of Object.keys(alarmsByCustomer)) {
      overviewDashboard.addWidgets(
        new cloudwatch.AlarmStatusWidget({
          title: 'Status: ' + customer,
          alarms: alarmsByCustomer[customer],
          width,
          height: 3
        }),
      );
    }

    for (const [kpiType,kpiTitle] of kpiTypeOrder) {
      const typeKpis = kpis.filter( ({kpi}) => kpi == kpiType );

      overviewDashboard.addWidgets(
        new cloudwatch.TextWidget({
          markdown: '## ' + kpiType,
          width,
          height: 2
        })
      )

      const metrics: (cloudwatch.Metric|cloudwatch.MathExpression)[] = typeKpis.map( (kpi) => {
        return kpi.metric.with({
          statistic: "average",
          label: `${kpi.customer}: ${kpi.label}`
        });
      });

      if (metrics.length) {
        const graphWidget = new cloudwatch.GraphWidget({
          title: kpiTitle,
          left: metrics,
          leftYAxis: {
            min: 0
          },
          width,
          height:8
        });
        overviewDashboard.addWidgets(graphWidget);
      }

    }

    const overviewDataloadGraph = new cloudwatch.GraphWidget({
      title: 'Data Load Failures',
      left: dataLoadMetrics,
      leftYAxis: {
        min: 0
      },
      width,
      height:5
    });
    overviewDashboard.addWidgets(overviewDataloadGraph);

  }

  createCustomerStatusAlarms(alarmsByCustomer: {[customer: string]: cloudwatch.CompositeAlarm[];}, dataAlarmsByCustomer: {[customer: string]: cloudwatch.Alarm;}): cloudwatch.IAlarm[] {

    const statusAlarms: cloudwatch.IAlarm[] = [];

    const customers = Object.keys(alarmsByCustomer);
    for (const customer of customers) {
      const dataAlarm = dataAlarmsByCustomer[customer];
      const alarms = alarmsByCustomer[customer];

      const alarmRule = cloudwatch.AlarmRule.anyOf(
        dataAlarm,
        ...alarms
      )

      const alarm = new cloudwatch.CompositeAlarm(this, `${fixName(customer)}-Status`, {
        compositeAlarmName: `${customer}: Status`,
        alarmRule
      });

      statusAlarms.push(alarm);


    }

    return statusAlarms;

  }



  createCustomerDashboards(kpis: KpiMonitor[],
                           alarmsByCustomer: { [customer: string]: cloudwatch.CompositeAlarm[] },
                           dataAlarmsByCustomer: { [customer: string]: cloudwatch.Alarm },
                           quietTimeAlarmsByCustomer: { [customer: string]: cloudwatch.Alarm }
                           ) {
    const width = 24;

    const byCustomer = groupBy(kpis, ({customer}) => {
      return customer;
    });


    for (const customer of Object.keys(byCustomer)) {
      const cleanName = customer.replace(/ /g, '-');
      const customerDashboard = new cloudwatch.Dashboard(this, 'CustomerDash' + cleanName, {
        dashboardName: 'Overview-' + cleanName
      });

      customerDashboard.addWidgets(
        new cloudwatch.AlarmStatusWidget({
          title: 'Alarms Status',
          alarms: [
            dataAlarmsByCustomer[customer],
            ...alarmsByCustomer[customer],
            quietTimeAlarmsByCustomer[customer]
          ],
          width,
          height: 4
        }),
      );

      const customerKpis = byCustomer[customer];
      for (const [kpiType,kpiTitle] of kpiTypeOrder) {
        const typeKpis = customerKpis.filter( ({kpi}) => kpi == kpiType );
        const metrics = typeKpis.map( ({metric}) => metric );

        if (metrics.length) {
          const graphWidget = new cloudwatch.GraphWidget({
            title: kpiType,
            left: metrics,
            leftYAxis: {
              min: 0
            },
            width,
            height:8
          });
          customerDashboard.addWidgets(graphWidget);
        }

      }

      const loadsWidget = new cloudwatch.GraphWidget({
        title: 'Data Load Failures',
        left: [dataAlarmsByCustomer[customer].metric],
        leftYAxis: {
          min: 0
        },
        width,
        height:3
      });
      customerDashboard.addWidgets(loadsWidget);

      const quietTimeWidget = new cloudwatch.GraphWidget({
        title: 'Quiet Time',
        left: [quietTimeAlarmsByCustomer[customer].metric],
        leftYAxis: {
          min: 0
        },
        width,
        height:3
      });
      customerDashboard.addWidgets(quietTimeWidget);


    }


  }

  createDashboardRows(arr: any[]) {
    let i = 0;
    const rows: any = [];
    let curr:any[] = [];
    for (const row of arr) {
      curr.push(row);
      i++;
      if (i >= 4) {
        rows.push(curr);
        curr = [];
        i = 0;
      }
    }
    rows.push(curr);
    return rows;
  }


  makeStepFunctionAlarms(opname: string, stateMachine: sfn.StateMachine) {

    const failedMetric = stateMachine.metricFailed().with({
      statistic: 'maximum'
    });
    const period = cdk.Duration.minutes(5);
    const evaluationPeriods = 4;
    const datapointsToAlarm = 3;
    const threshold = 1;

    const statemachineFailedAlarm = new cloudwatch.Alarm(this, `${opname} Data Failed`, {
      alarmName: `${opname} Data Loading Status`,
      alarmDescription: 'The data loading is failing for customer ' + opname,
      metric: failedMetric,
      threshold,
      evaluationPeriods,
      datapointsToAlarm,
      period,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING
    });

    return statemachineFailedAlarm;
  }


  manageQuietTime( quietTimes: CustomerQuietTime[], manageQuietTime: lambda.Function) {

    const checkQuietTimesSchedule: Rule = new Rule(this, 'QuietTimeManagerSchedule', {
      schedule: Schedule.rate(cdk.Duration.minutes(5))
    });
    checkQuietTimesSchedule.addTarget(new LambdaFunction(manageQuietTime, {
      event: RuleTargetInput.fromObject({
        quietTimes
      })
    }));

  }

  createOperatorAlarmDefinition(customer: Customer): customerAlarmDefinitions {

    const customerAlarms: customerAlarmDefinitions = {
      customer: customer.opname,
      createAlarms: [],
      quietTime: customer.quietTime
    }

    customerAlarms.createAlarms.push(new DemoAlarms(customer.demoParams));

    return customerAlarms;
  }

  /*
   * This is a workaround for AWS' arbitrary limit of 5 targets per rule.
   * I don't want 20 different schedules, so we create batches with less than
   * 5 targets in them
   */
  getShortFetchSchedule() {
    if (!this.fetchSchedule || this.addedTargets >= 4) {
      this.fetchSchedule = new Rule(this, `Schedule Fetches ` + this.addedSchedules, {
        schedule: Schedule.rate(cdk.Duration.minutes(5)),
      });
      this.addedSchedules++;
      this.addedTargets = 0;
    }
    this.addedTargets++;
    return this.fetchSchedule;
  }

  getLongFetchSchedule() {
    if (!this.fetchLongSchedule || this.addedLongTargets >= 4) {
      this.fetchLongSchedule = new Rule(this, `Schedule Long Fetches ` + this.addedSchedules, {
        schedule: Schedule.rate(cdk.Duration.minutes(30)),
      });
      this.addedLongSchedules++;
      this.addedLongTargets = 0;
    }
    this.addedLongTargets++;
    return this.fetchLongSchedule;
  }

}

// Used for the queries
function makeTags(customer: Customer): string[]  {
  const tags: string[] = []
  tags.push('v' + customer.version);
  tags.push('demo');
  return tags;
}

function fixName(name: string) {
  return name.replace(/ /g, '-');
}


