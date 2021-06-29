import * as iam from '@aws-cdk/aws-iam';
import * as events from '@aws-cdk/aws-events';
import * as cdk from '@aws-cdk/core';
import * as cloudwatch from '@aws-cdk/aws-cloudwatch';
import * as lambda from '@aws-cdk/aws-lambda';
import * as targets from '@aws-cdk/aws-events-targets';

export type QuietTimeDef = {
  startHourUTC: string,
  endHourUTC: string
}

export class QuietTime {

  quietTimeFunction: lambda.Function;
  rules: events.Rule[];

  scope: cdk.Stack;
  cloudwatchPolicyStatement: iam.PolicyStatement;

  constructor(scope: cdk.Stack, cloudwatchPolicyStatement: iam.PolicyStatement) {
    this.scope = scope;

    this.cloudwatchPolicyStatement = cloudwatchPolicyStatement;

    this.quietTimeFunction = new lambda.Function(scope, "QuietTimeAlarmDisablerEnabled", {
      handler:'index.handler',
      runtime: lambda.Runtime.NODEJS_12_X,
      code: lambda.Code.asset(__dirname + "/lambda/quiet-time-handler"),
      timeout: cdk.Duration.seconds(120),
    });
    this.quietTimeFunction.addToRolePolicy(this.cloudwatchPolicyStatement);
  }

  addQuietTime(customer: string, alarms: cloudwatch.Alarm[], quietTime: QuietTimeDef): void  {
    const alarmNames = alarms.map( (alarm: cloudwatch.Alarm) => {
      return alarm.alarmName
    });


    const disableRule: events.Rule = new events.Rule(this.scope, [customer,'quiet','disable'].join('-'), {
      schedule: events.Schedule.cron({
        hour: quietTime.startHourUTC,
        minute: "00"
      })
    });
    disableRule.addTarget(new targets.LambdaFunction(this.quietTimeFunction, {
      event: events.RuleTargetInput.fromObject({
        type: 'disable',
        alarms: alarmNames
      })
    }));

    const enableRule: events.Rule = new events.Rule(this.scope, [customer,'quiet','enable'].join('-'), {
      schedule: events.Schedule.cron({
        hour: quietTime.endHourUTC,
        minute: "00"
      })
    });
    enableRule.addTarget(new targets.LambdaFunction(this.quietTimeFunction, {
      event: events.RuleTargetInput.fromObject({
        type: 'enable',
        alarms: alarmNames
      })
    }));



  }
}
