import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Download, Smartphone, Check, Bell, ArrowLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { usePushNotifications } from '@/hooks/usePushNotifications';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const Install = () => {
  const navigate = useNavigate();
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const { permission, requestPermission, isSupported } = usePushNotifications();

  useEffect(() => {
    // Check if already installed
    if (window.matchMedia('(display-mode: standalone)').matches) {
      setIsInstalled(true);
    }

    // Check for iOS
    const isIOSDevice = /iPad|iPhone|iPod/.test(navigator.userAgent);
    setIsIOS(isIOSDevice);

    // Listen for install prompt
    const handleBeforeInstall = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstall);

    // Listen for app installed
    window.addEventListener('appinstalled', () => {
      setIsInstalled(true);
      setDeferredPrompt(null);
    });

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstall);
    };
  }, []);

  const handleInstall = async () => {
    if (!deferredPrompt) return;

    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    
    if (outcome === 'accepted') {
      setIsInstalled(true);
    }
    setDeferredPrompt(null);
  };

  const handleEnableNotifications = async () => {
    await requestPermission();
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-white flex flex-col">
      <header className="p-4 border-b border-gray-200 bg-white/80 backdrop-blur-sm">
        <Button variant="ghost" onClick={() => navigate(-1)} className="gap-2">
          <ArrowLeft className="h-4 w-4" />
          Back
        </Button>
      </header>

      <main className="flex-1 flex items-center justify-center p-6">
        <div className="max-w-md w-full space-y-8 text-center">
          <div className="space-y-4">
            <div className="w-24 h-24 mx-auto bg-gradient-to-br from-blue-500 to-blue-600 rounded-3xl flex items-center justify-center shadow-lg">
              <Smartphone className="h-12 w-12 text-white" />
            </div>
            <h1 className="text-3xl font-bold text-gray-900">Install PulseChat</h1>
            <p className="text-gray-600">
              Install the app on your device for the best experience with push notifications and offline access.
            </p>
          </div>

          <div className="space-y-4">
            {isInstalled ? (
              <div className="flex items-center justify-center gap-2 text-green-600 bg-green-50 p-4 rounded-xl border border-green-200">
                <Check className="h-5 w-5" />
                <span className="font-medium">App installed successfully!</span>
              </div>
            ) : isIOS ? (
              <div className="bg-gray-50 p-6 rounded-xl border border-gray-200 text-left space-y-3">
                <h3 className="font-semibold text-gray-900">Install on iOS:</h3>
                <ol className="list-decimal list-inside space-y-2 text-gray-600">
                  <li>Tap the <strong>Share</strong> button in Safari</li>
                  <li>Scroll down and tap <strong>"Add to Home Screen"</strong></li>
                  <li>Tap <strong>"Add"</strong> to install</li>
                </ol>
              </div>
            ) : deferredPrompt ? (
              <Button 
                onClick={handleInstall}
                size="lg"
                className="w-full bg-blue-500 hover:bg-blue-600 text-white gap-2"
              >
                <Download className="h-5 w-5" />
                Install App
              </Button>
            ) : (
              <div className="bg-gray-50 p-6 rounded-xl border border-gray-200 text-left space-y-3">
                <h3 className="font-semibold text-gray-900">Install on Android:</h3>
                <ol className="list-decimal list-inside space-y-2 text-gray-600">
                  <li>Tap the <strong>menu</strong> (three dots) in Chrome</li>
                  <li>Tap <strong>"Add to Home screen"</strong></li>
                  <li>Tap <strong>"Add"</strong> to install</li>
                </ol>
              </div>
            )}

            {/* Push Notifications */}
            {isSupported && (
              <div className="pt-4 border-t border-gray-200">
                <h3 className="font-semibold text-gray-900 mb-3">Push Notifications</h3>
                {permission === 'granted' ? (
                  <div className="flex items-center justify-center gap-2 text-green-600 bg-green-50 p-4 rounded-xl border border-green-200">
                    <Check className="h-5 w-5" />
                    <span className="font-medium">Notifications enabled!</span>
                  </div>
                ) : permission === 'denied' ? (
                  <div className="text-gray-500 bg-gray-50 p-4 rounded-xl border border-gray-200">
                    Notifications blocked. Please enable them in your browser settings.
                  </div>
                ) : (
                  <Button 
                    onClick={handleEnableNotifications}
                    variant="outline"
                    size="lg"
                    className="w-full gap-2"
                  >
                    <Bell className="h-5 w-5" />
                    Enable Notifications
                  </Button>
                )}
              </div>
            )}
          </div>

          <Button 
            variant="ghost" 
            onClick={() => navigate('/chat')}
            className="text-gray-600"
          >
            Continue to Chat →
          </Button>
        </div>
      </main>
    </div>
  );
};

export default Install;
