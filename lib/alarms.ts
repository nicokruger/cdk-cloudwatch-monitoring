import * as cloudwatch from '@aws-cdk/aws-cloudwatch';
import * as cdk from '@aws-cdk/core';

export interface CreateAlarms {
  createAlarms(scope: cdk.Stack, namespace: string, customer: string): KpiChecks
}

export interface DemoProps {
  enabled: boolean;
  threshold: number;
}

export type DemoParameters = Require<DemoProps, 'threshold' >
const defaultAlarmsProps: DemoProps = {
  enabled: true,
  threshold: 4,
}

export class DemoAlarms implements CreateAlarms {

  props: DemoProps;

  public constructor(props: DemoParameters) {
    this.props = {...defaultAlarmsProps, ...props};
  }

  public createAlarms(scope: cdk.Stack, namespace: string, customer: string): KpiChecks {
    const demoMetric = new cloudwatch.Metric({
      namespace,
      metricName: 'test_metric',
      dimensions: {
        [customer]: 'demo'
      }
    });
    const demoAlarmName = `${customer}: Demo Alarm`;
    const demoAlarm = new cloudwatch.Alarm(scope, [customer, 'Demo Alarm'].join('-'), {
      alarmName: makeInnerAlarmName(demoAlarmName),
      alarmDescription: 'A demo alarm',
      metric: demoMetric,
      threshold: this.props.threshold,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING
    });

    const demoMetric2 = new cloudwatch.Metric({
      namespace,
      metricName: 'test_metric2',
      dimensions: {
        [customer]: 'demo'
      }
    });
    const demoAlarmName2 = `${customer}: Demo Alarm2`;
    const demoAlarm2 = new cloudwatch.Alarm(scope, [customer, 'Demo Alarm2'].join('-'), {
      alarmName: makeInnerAlarmName(demoAlarmName2),
      alarmDescription: 'A demo alarm2',
      metric: demoMetric2,
      threshold: this.props.threshold,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING
    });

    const defaultAlarms: AlarmSpec[] = [
      {
        alarm:demoAlarm,
        name:demoAlarmName,
        disableDuringQuietTime: true
      },
      {
        alarm:demoAlarm2,
        name:demoAlarmName2,
        disableDuringQuietTime: true
      }
    ]


    return {
      alarms: defaultAlarms,
      kpis: [
        {
          kpi: Kpi.DEMO,
          label: 'test_metric',
          metric: demoMetric,
          customer: customer
        },
        {
          kpi: Kpi.DEMO,
          label: 'test_metric2',
          metric: demoMetric2,
          customer: customer
        }
      ]
    }

  }
}

export function createQuietTimeAlarm(scope: cdk.Stack, customer: string, namespace: string) {

  const quietTimeMetric = new cloudwatch.Metric({
    namespace,
    metricName: 'quiet_time',
    dimensions: {
      [customer]: 'Status'
    }
  });

  const quietTimeAlarm = new cloudwatch.Alarm(scope, 'Quiet Time ' + customer, {
    alarmName: `${customer}: Is in Quiet Time`,
    alarmDescription: 'The customer is currently in quiet time. This alarm blocks all other alarms from firing',
    metric: quietTimeMetric,
    threshold: 1,
    evaluationPeriods: 1,
    datapointsToAlarm: 1,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    treatMissingData: cloudwatch.TreatMissingData.IGNORE
  });
  return quietTimeAlarm;
}

export type Require<T, K extends keyof T> = {
    [X in Exclude<keyof T, K>]?: T[X]
} & {
    [P in K]-?: T[P]
}

export interface AlarmSpec {
  disableDuringQuietTime: boolean;
  name: string;
  alarm: cloudwatch.Alarm;
}

export enum Kpi {
  DEMO = "Demo",
}

export type KpiMonitor = {
  kpi: Kpi;
  metric: cloudwatch.Metric | cloudwatch.MathExpression;
  label: string;
  customer: string;
}

export type KpiChecks = {
  alarms: AlarmSpec[];
  kpis: KpiMonitor[];
}

function makeInnerAlarmName(alarmName: string) {
  return 'I-'+alarmName;
}


