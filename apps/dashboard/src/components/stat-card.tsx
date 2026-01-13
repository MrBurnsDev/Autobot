import { Card } from './card';
import { cn } from '@/lib/utils';
import { LucideIcon } from 'lucide-react';

interface StatCardProps {
  title: string;
  value: string;
  subValue?: string;
  icon?: LucideIcon;
  trend?: 'up' | 'down' | 'neutral';
  className?: string;
}

export function StatCard({
  title,
  value,
  subValue,
  icon: Icon,
  trend,
  className,
}: StatCardProps) {
  return (
    <Card className={cn('', className)}>
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-muted-foreground">{title}</p>
          <p
            className={cn(
              'mt-1 text-2xl font-semibold',
              trend === 'up' && 'text-green-400',
              trend === 'down' && 'text-red-400'
            )}
          >
            {value}
          </p>
          {subValue && (
            <p className="mt-1 text-sm text-muted-foreground">{subValue}</p>
          )}
        </div>
        {Icon && (
          <div className="rounded-lg bg-secondary p-2">
            <Icon className="h-5 w-5 text-muted-foreground" />
          </div>
        )}
      </div>
    </Card>
  );
}
