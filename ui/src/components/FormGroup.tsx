import { ReactNode } from 'react';

interface FormGroupProps {
  label: string;
  htmlFor?: string;
  required?: boolean;
  helpText?: string;
  error?: string;
  children: ReactNode;
}

/**
 * Standardized form group component with label, input, help text, and error display.
 * Replaces the repeated label + input + help text pattern across the application.
 */
export function FormGroup({
  label,
  htmlFor,
  required,
  helpText,
  error,
  children,
}: FormGroupProps) {
  return (
    <div>
      <label htmlFor={htmlFor} className="label">
        {label}
        {required && <span className="text-red-400 ml-1">*</span>}
      </label>
      {children}
      {error && <p className="help-text text-red-400">{error}</p>}
      {helpText && !error && <p className="help-text">{helpText}</p>}
    </div>
  );
}

export default FormGroup;
