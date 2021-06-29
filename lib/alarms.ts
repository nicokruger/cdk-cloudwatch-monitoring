import * as cloudwatch from '@aws-cdk/aws-cloudwatch';
import * as cdk from '@aws-cdk/core';

export interface CreateAlarms {
  createAlarms(scope: cdk.Stack, namespace: string, customer: string): KpiChecks
}

export interface DemoProps {
  enabled: boolean;
  threshold: number;
  enableAnomalyDetection: boolean;
  anomalyDetectionBand: number;
}

export type DemoParameters = Require<DemoProps, 'threshold' >
const defaultAlarmsProps: DemoProps = {
  enabled: true,
  threshold: 4,
  enableAnomalyDetection: false,
  anomalyDetectionBand: 0.5
}

export class DemoAlarms implements CreateAlarms {

  anomaly_detector: cloudwatch.CfnAnomalyDetector;
  props: DemoProps;

  public constructor(props: DemoParameters) {
    this.props = {...defaultAlarmsProps, ...props};
  }

  public createAlarms(scope: cdk.Stack, namespace: string, customer: string): KpiChecks {
    // Create two metrics
    const demoMetric = new cloudwatch.Metric({
      namespace,
      metricName: 'test_metric',
      dimensions: {
        [customer]: 'demo'
      }
    });
    const demoMetric2 = new cloudwatch.Metric({
      namespace,
      metricName: 'test_metric2',
      dimensions: {
        [customer]: 'demo'
      }
    });

    // First Alarm
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

    // Second Alarm
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

    const alarms: AlarmSpec[] = [
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


    if (this.props.enableAnomalyDetection) {
      this.createAnomalyDetectionAlarm(demoMetric, scope, namespace, customer, alarms);
    }


    return {
      alarms: alarms,
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

  createAnomalyDetectionAlarm(metric: cloudwatch.Metric, scope: cdk.Stack, namespace: string, customer: string, alarms: AlarmSpec[]) {
    // if first time, create anomaly detection model
    if (this.anomaly_detector == undefined) {
      this.anomaly_detector = new cloudwatch.CfnAnomalyDetector(
        scope, ["Purchase24HourAnomalyDetector"].join("-"),{
          metricName:"test_metric",
          namespace:namespace,
          stat:"Average",
          dimensions: [{
            name: customer,
            value: 'demo'
          }]
        })
    } else {
      // use existing anomaly detection model
      const dims = (this.anomaly_detector?.dimensions) as cloudwatch.CfnAnomalyDetector.DimensionProperty[];
      dims.push({
        name: customer,
        value: 'demo'
      });
      console.log('adding dimension', dims.length);
    }

    const anomalyAlarmName = `Anomaly Detection Demo`;
    const anomalyAlarm = new cloudwatch.Alarm(scope, [customer, 'Anomaly Detection Alarm'].join('-'), {
      alarmName: makeInnerAlarmName(anomalyAlarmName),
      alarmDescription: 'Anomalous value detected',
      metric,
      threshold: this.props.anomalyDetectionBand,
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      treatMissingData: cloudwatch.TreatMissingData.IGNORE,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_LOWER_THRESHOLD,
    });
    const cfnAnomalyAlarm = anomalyAlarm.node.defaultChild as cloudwatch.CfnAlarm;

    const adId = 'ad_' + customer.toLowerCase().replace(/ /g, '_');
    const mId = 'm_' + customer.toLowerCase().replace(/ /g, '_');

    cfnAnomalyAlarm.metrics = [
      {
        expression: `ANOMALY_DETECTION_BAND(${mId}, ${this.props.anomalyDetectionBand})`,
        id: adId
      },
      {
        id:mId,
        metricStat: {
          metric: {
            metricName: this.anomaly_detector.metricName,
            namespace: this.anomaly_detector.namespace,
            dimensions: [{
              name: customer,
              value: 'demo'
            }]
          },
          period: cdk.Duration.minutes(15).toSeconds(),
          //period: cdk.Duration.minutes(5).toSeconds(),
          stat: "Average"
        }
      }

    ]
    cfnAnomalyAlarm.thresholdMetricId = adId;
    cfnAnomalyAlarm.metricName = undefined;
    cfnAnomalyAlarm.statistic = undefined;
    cfnAnomalyAlarm.namespace = undefined;
    cfnAnomalyAlarm.period = undefined;
    cfnAnomalyAlarm.dimensions = undefined;
    cfnAnomalyAlarm.threshold = undefined;

    alarms.push({
      alarm:anomalyAlarm,
      name:anomalyAlarmName,
      disableDuringQuietTime: true
    })

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


