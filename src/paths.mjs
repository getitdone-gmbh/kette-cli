import os from 'node:os';
import path from 'node:path';

// Alles der Kette liegt unter ~/.kette, überschreibbar für Tests und Firmen-Installationen
export const home = () => process.env.KETTE_HOME || path.join(os.homedir(), '.kette');
export const bundlesDir = () => path.join(home(), 'bundles');
export const activeBundleLink = () => path.join(bundlesDir(), 'active');
export const credentialsFile = () => path.join(home(), 'credentials');
export const deviceIdFile = () => path.join(home(), 'device-id');
export const stateFile = () => path.join(home(), 'state.json');
export const mirror = () => (process.env.KETTE_MIRROR || 'https://kette.itdone.de/dl').replace(/\/$/, '');
export const delivery = () => (process.env.KETTE_DELIVERY || 'https://app-kette-delivery-833790b5.itdone.cloud').replace(/\/$/, '');
