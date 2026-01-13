import { prisma, AlertType } from '@autobot/db';
import { Logger, retryWithBackoff } from '@autobot/core';

const logger = new Logger('AlertService');

export interface AlertPayload {
  instanceId?: string;
  type: AlertType;
  title: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export class AlertService {
  private webhookUrl?: string;
  private discordWebhookUrl?: string;

  constructor(webhookUrl?: string, discordWebhookUrl?: string) {
    this.webhookUrl = webhookUrl;
    this.discordWebhookUrl = discordWebhookUrl;
  }

  async sendAlert(payload: AlertPayload): Promise<void> {
    // Store alert in database
    const alert = await prisma.alertEvent.create({
      data: {
        instanceId: payload.instanceId,
        type: payload.type,
        title: payload.title,
        message: payload.message,
        metadata: payload.metadata ?? {},
      },
    });

    // Send to webhooks in background
    const deliveryPromises: Promise<void>[] = [];

    if (this.webhookUrl) {
      deliveryPromises.push(this.deliverWebhook(alert.id, payload));
    }

    if (this.discordWebhookUrl) {
      deliveryPromises.push(this.deliverDiscord(alert.id, payload));
    }

    // Don't await - let deliveries happen in background
    Promise.allSettled(deliveryPromises).catch((err) => {
      logger.error('Alert delivery failed', { error: (err as Error).message });
    });
  }

  private async deliverWebhook(alertId: string, payload: AlertPayload): Promise<void> {
    if (!this.webhookUrl) return;

    try {
      await retryWithBackoff(
        async () => {
          const res = await fetch(this.webhookUrl!, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: payload.type,
              title: payload.title,
              message: payload.message,
              metadata: payload.metadata,
              timestamp: new Date().toISOString(),
            }),
          });

          if (!res.ok) {
            throw new Error(`Webhook delivery failed: ${res.status}`);
          }
        },
        { maxRetries: 2, initialDelayMs: 1000, maxDelayMs: 5000 }
      );

      await prisma.alertEvent.update({
        where: { id: alertId },
        data: { webhookDelivered: true },
      });
    } catch (err) {
      await prisma.alertEvent.update({
        where: { id: alertId },
        data: { webhookError: (err as Error).message },
      });
    }
  }

  private async deliverDiscord(alertId: string, payload: AlertPayload): Promise<void> {
    if (!this.discordWebhookUrl) return;

    try {
      // Format for Discord embed
      const color = this.getDiscordColor(payload.type);
      const embed = {
        title: payload.title,
        description: payload.message,
        color,
        timestamp: new Date().toISOString(),
        fields: payload.metadata
          ? Object.entries(payload.metadata).map(([name, value]) => ({
              name,
              value: String(value),
              inline: true,
            }))
          : [],
      };

      await retryWithBackoff(
        async () => {
          const res = await fetch(this.discordWebhookUrl!, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ embeds: [embed] }),
          });

          if (!res.ok) {
            throw new Error(`Discord delivery failed: ${res.status}`);
          }
        },
        { maxRetries: 2, initialDelayMs: 1000, maxDelayMs: 5000 }
      );

      await prisma.alertEvent.update({
        where: { id: alertId },
        data: { discordDelivered: true },
      });
    } catch (err) {
      await prisma.alertEvent.update({
        where: { id: alertId },
        data: { discordError: (err as Error).message },
      });
    }
  }

  private getDiscordColor(type: AlertType): number {
    switch (type) {
      case 'BOT_STARTED':
        return 0x00ff00; // Green
      case 'BOT_STOPPED':
        return 0xffff00; // Yellow
      case 'TRADE_EXECUTED':
        return 0x0099ff; // Blue
      case 'TRADE_FAILED':
        return 0xff6600; // Orange
      case 'CIRCUIT_BREAKER':
        return 0xff0000; // Red
      case 'ERROR':
        return 0xff0000; // Red
      case 'DAILY_SUMMARY':
        return 0x9900ff; // Purple
      default:
        return 0x808080; // Gray
    }
  }
}
