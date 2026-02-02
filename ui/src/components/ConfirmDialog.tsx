import { Modal } from './Modal';
import { WarningIcon, TrashIcon, ErrorIcon } from './Icons';

export type ConfirmVariant = 'danger' | 'warning' | 'info';

interface ConfirmDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: ConfirmVariant;
  loading?: boolean;
}

const variantConfig: Record<
  ConfirmVariant,
  {
    iconBg: string;
    icon: typeof WarningIcon;
    iconColor: string;
    buttonClass: string;
  }
> = {
  danger: {
    iconBg: 'bg-red-900/50',
    icon: TrashIcon,
    iconColor: 'text-red-400',
    buttonClass: 'bg-red-600 hover:bg-red-700 text-white',
  },
  warning: {
    iconBg: 'bg-yellow-900/50',
    icon: WarningIcon,
    iconColor: 'text-yellow-400',
    buttonClass: 'bg-yellow-600 hover:bg-yellow-700 text-white',
  },
  info: {
    iconBg: 'bg-blue-900/50',
    icon: ErrorIcon,
    iconColor: 'text-blue-400',
    buttonClass: 'btn-primary',
  },
};

export function ConfirmDialog({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  variant = 'danger',
  loading = false,
}: ConfirmDialogProps) {
  const config = variantConfig[variant];
  const Icon = config.icon;

  const handleConfirm = () => {
    onConfirm();
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="sm" showCloseButton={false}>
      <div className="flex flex-col items-center text-center">
        <div
          className={`w-12 h-12 rounded-full ${config.iconBg} flex items-center justify-center mb-4`}
        >
          <Icon className={`w-6 h-6 ${config.iconColor}`} />
        </div>

        <h3 className="text-lg font-semibold text-white mb-2">{title}</h3>
        <p className="text-slate-400 text-sm mb-6">{message}</p>

        <div className="flex gap-3 w-full">
          <button
            onClick={onClose}
            disabled={loading}
            className="btn btn-ghost flex-1"
          >
            {cancelText}
          </button>
          <button
            onClick={handleConfirm}
            disabled={loading}
            className={`btn flex-1 ${config.buttonClass}`}
          >
            {loading ? 'Loading...' : confirmText}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export default ConfirmDialog;
