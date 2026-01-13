import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(value: number, decimals: number = 2): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

export function formatNumber(value: number, decimals: number = 4): string {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

export function formatPercent(value: number, decimals: number = 2): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(decimals)}%`;
}

export function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleString();
}

export function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  return `${diffDay}d ago`;
}

export function getExplorerUrl(chain: 'SOLANA' | 'AVALANCHE', txHash: string): string {
  if (chain === 'SOLANA') {
    return `https://solscan.io/tx/${txHash}`;
  }
  return `https://snowtrace.io/tx/${txHash}`;
}

export function getStatusColor(status: string): string {
  switch (status) {
    case 'RUNNING':
      return 'text-green-400';
    case 'STOPPED':
      return 'text-gray-400';
    case 'PAUSED':
      return 'text-yellow-400';
    case 'ERROR':
      return 'text-red-400';
    case 'CONFIRMED':
      return 'text-green-400';
    case 'FAILED':
      return 'text-red-400';
    case 'PENDING':
    case 'SUBMITTED':
      return 'text-yellow-400';
    default:
      return 'text-gray-400';
  }
}

export function getPnLColor(value: number): string {
  if (value > 0) return 'text-green-400';
  if (value < 0) return 'text-red-400';
  return 'text-gray-400';
}
