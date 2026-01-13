'use client';

import { Card, CardHeader, CardTitle, CardContent } from '@/components/card';
import { Bell, CheckCircle, XCircle, AlertTriangle, Info } from 'lucide-react';

export default function AlertsPage() {
  // In a full implementation, this would fetch from the API
  // For now, show a placeholder with alert configuration info

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Alerts</h1>
        <p className="text-muted-foreground">
          Configure notifications and view alert history
        </p>
      </div>

      {/* Alert Configuration */}
      <Card>
        <CardHeader>
          <CardTitle>Notification Settings</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Configure webhooks in your bot configuration to receive alerts for:
            </p>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="flex items-start gap-3 p-4 rounded-lg bg-secondary">
                <CheckCircle className="h-5 w-5 text-green-400 mt-0.5" />
                <div>
                  <p className="font-medium">Bot Started/Stopped</p>
                  <p className="text-sm text-muted-foreground">
                    Get notified when your trading bot starts or stops
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3 p-4 rounded-lg bg-secondary">
                <Info className="h-5 w-5 text-blue-400 mt-0.5" />
                <div>
                  <p className="font-medium">Trade Executed</p>
                  <p className="text-sm text-muted-foreground">
                    Receive alerts for each successful trade execution
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3 p-4 rounded-lg bg-secondary">
                <XCircle className="h-5 w-5 text-red-400 mt-0.5" />
                <div>
                  <p className="font-medium">Trade Failed</p>
                  <p className="text-sm text-muted-foreground">
                    Get notified when a trade fails to execute
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3 p-4 rounded-lg bg-secondary">
                <AlertTriangle className="h-5 w-5 text-yellow-400 mt-0.5" />
                <div>
                  <p className="font-medium">Circuit Breaker</p>
                  <p className="text-sm text-muted-foreground">
                    Alert when safety controls pause trading
                  </p>
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Webhook Setup Instructions */}
      <Card>
        <CardHeader>
          <CardTitle>Webhook Setup</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div>
              <h4 className="font-medium mb-2">Generic Webhook</h4>
              <p className="text-sm text-muted-foreground mb-2">
                Set the webhookUrl in your bot configuration to receive JSON payloads:
              </p>
              <pre className="bg-secondary p-4 rounded-lg text-sm overflow-x-auto">
{`{
  "type": "TRADE_EXECUTED",
  "title": "BUY Executed",
  "message": "BUY 0.5 SOL @ 23.45 USDC",
  "metadata": {
    "side": "BUY",
    "baseQty": 0.5,
    "quoteQty": 11.725,
    "price": 23.45,
    "txSignature": "..."
  },
  "timestamp": "2024-01-01T12:00:00Z"
}`}
              </pre>
            </div>

            <div>
              <h4 className="font-medium mb-2">Discord Webhook</h4>
              <p className="text-sm text-muted-foreground mb-2">
                Set the discordWebhookUrl for formatted Discord messages:
              </p>
              <ol className="list-decimal list-inside text-sm text-muted-foreground space-y-1">
                <li>Open Discord and go to Server Settings</li>
                <li>Navigate to Integrations, then Webhooks</li>
                <li>Create a new webhook and copy the URL</li>
                <li>Paste the URL in your bot configuration</li>
              </ol>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Recent Alerts (Placeholder) */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Alerts</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-12">
            <Bell className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <p className="text-muted-foreground">No recent alerts</p>
            <p className="text-sm text-muted-foreground mt-2">
              Alerts will appear here once your bot starts trading
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
