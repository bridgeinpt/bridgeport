import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Dialog, DialogContent, DialogTitle } from './dialog';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
} from './alert-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';
import { Switch } from './switch';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './tabs';
import { Progress } from './progress';

/**
 * Phase 8 a11y (#254): the shadcn/Radix primitives expose correct roles +
 * accessible names for free. These role-based assertions are the query style
 * the rest of the suite should follow.
 */
describe('primitive accessibility roles', () => {
  it('Dialog exposes role="dialog" with an accessible name', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Edit server</DialogTitle>
        </DialogContent>
      </Dialog>
    );
    expect(screen.getByRole('dialog', { name: 'Edit server' })).toBeInTheDocument();
  });

  it('AlertDialog exposes role="alertdialog" with an accessible name', () => {
    render(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogTitle>Delete?</AlertDialogTitle>
        </AlertDialogContent>
      </AlertDialog>
    );
    expect(screen.getByRole('alertdialog', { name: 'Delete?' })).toBeInTheDocument();
  });

  it('Select trigger is a combobox; Switch is a switch; Progress is a progressbar', () => {
    render(
      <>
        <Select>
          <SelectTrigger aria-label="Environment">
            <SelectValue placeholder="Pick" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="a">A</SelectItem>
          </SelectContent>
        </Select>
        <Switch aria-label="Auto-refresh" />
        <Progress value={50} />
      </>
    );
    expect(screen.getByRole('combobox', { name: 'Environment' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Auto-refresh' })).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('Tabs expose tab roles with accessible names', () => {
    render(
      <Tabs defaultValue="status">
        <TabsList>
          <TabsTrigger value="status">Status</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
        </TabsList>
        <TabsContent value="status">x</TabsContent>
      </Tabs>
    );
    expect(screen.getByRole('tab', { name: 'Status' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Logs' })).toBeInTheDocument();
  });
});
