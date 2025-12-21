import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Video, VideoOff, Mic, MicOff, PhoneOff, RefreshCw } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

interface VideoCallProps {
  isOpen: boolean;
  onClose: () => void;
  roomUrl?: string;
  onRoomCreated?: (roomUrl: string) => void;
}

declare global {
  interface Window {
    JitsiMeetExternalAPI: any;
  }
}

export const VideoCall: React.FC<VideoCallProps> = ({
  isOpen,
  onClose,
  roomUrl,
  onRoomCreated
}) => {
  const { toast } = useToast();
  const jitsiContainerRef = useRef<HTMLDivElement>(null);
  const [api, setApi] = useState<any>(null);
  const [isJoined, setIsJoined] = useState(false);
  const [isCameraOn, setIsCameraOn] = useState(true);
  const [isMicOn, setIsMicOn] = useState(true);
  const [participants, setParticipants] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentRoomName, setCurrentRoomName] = useState<string | null>(null);
  const initAttempted = useRef(false);

  const createRoom = useCallback(() => {
    const roomName = `chatapp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const jitsiRoomUrl = `https://meet.jit.si/${roomName}`;
    
    if (onRoomCreated) {
      onRoomCreated(jitsiRoomUrl);
    }
    
    return roomName;
  }, [onRoomCreated]);

  const loadJitsiScript = (): Promise<void> => {
    return new Promise((resolve, reject) => {
      if (window.JitsiMeetExternalAPI) {
        console.log('Jitsi API already loaded');
        resolve();
        return;
      }

      // Check if script is already being loaded
      const existingScript = document.querySelector('script[src="https://meet.jit.si/external_api.js"]');
      if (existingScript) {
        existingScript.addEventListener('load', () => resolve());
        existingScript.addEventListener('error', () => reject(new Error('Failed to load Jitsi script')));
        return;
      }

      console.log('Loading Jitsi Meet API script...');
      const script = document.createElement('script');
      script.src = 'https://meet.jit.si/external_api.js';
      script.async = true;
      script.onload = () => {
        console.log('Jitsi script loaded successfully');
        resolve();
      };
      script.onerror = () => {
        console.error('Failed to load Jitsi script');
        reject(new Error('Failed to load video call service. Please check your internet connection.'));
      };
      document.head.appendChild(script);
    });
  };

  const startJitsiMeeting = useCallback((roomName: string) => {
    console.log('Starting Jitsi meeting with room:', roomName);
    
    if (!jitsiContainerRef.current) {
      console.error('Container not found when starting meeting');
      setError('Video container not ready. Please try again.');
      setIsLoading(false);
      return;
    }

    if (!window.JitsiMeetExternalAPI) {
      console.error('Jitsi API not available when starting meeting');
      setError('Video service not loaded. Please try again.');
      setIsLoading(false);
      return;
    }

    try {
      // Clear any existing content in the container
      jitsiContainerRef.current.innerHTML = '';

      const options = {
        roomName: roomName,
        width: '100%',
        height: '100%',
        parentNode: jitsiContainerRef.current,
        configOverwrite: {
          startWithAudioMuted: false,
          startWithVideoMuted: false,
          prejoinPageEnabled: false,
          enableWelcomePage: false,
          disableDeepLinking: true,
          disableThirdPartyRequests: true,
          enableClosePage: false,
        },
        interfaceConfigOverwrite: {
          TOOLBAR_BUTTONS: [
            'microphone', 'camera', 'hangup', 'chat', 'filmstrip', 'tileview'
          ],
          SHOW_JITSI_WATERMARK: false,
          SHOW_WATERMARK_FOR_GUESTS: false,
          SHOW_BRAND_WATERMARK: false,
          SHOW_POWERED_BY: false,
          SETTINGS_SECTIONS: ['devices'],
          DISABLE_JOIN_LEAVE_NOTIFICATIONS: true,
          MOBILE_APP_PROMO: false,
        },
        userInfo: {
          displayName: `User-${Math.random().toString(36).substr(2, 5)}`
        }
      };
      
      console.log('Creating Jitsi API with options:', options);
      const jitsiApi = new window.JitsiMeetExternalAPI('meet.jit.si', options);
      console.log('Jitsi API created successfully');
      
      jitsiApi.addEventListener('participantJoined', (participant: any) => {
        console.log('Participant joined:', participant);
        setParticipants(prev => [...prev, participant]);
      });

      jitsiApi.addEventListener('participantLeft', (participant: any) => {
        console.log('Participant left:', participant);
        setParticipants(prev => prev.filter(p => p.id !== participant.id));
      });

      jitsiApi.addEventListener('videoConferenceJoined', () => {
        console.log('Video conference joined successfully');
        setIsJoined(true);
        setIsLoading(false);
        setError(null);
        toast({
          title: "Call Connected",
          description: "Video call connected successfully!",
        });
      });

      jitsiApi.addEventListener('videoConferenceLeft', () => {
        console.log('Video conference left');
        setIsJoined(false);
        onClose();
      });

      jitsiApi.addEventListener('audioMuteStatusChanged', (event: any) => {
        setIsMicOn(!event.muted);
      });

      jitsiApi.addEventListener('videoMuteStatusChanged', (event: any) => {
        setIsCameraOn(!event.muted);
      });

      jitsiApi.addEventListener('readyToClose', () => {
        console.log('Jitsi ready to close');
        setIsJoined(false);
        onClose();
      });

      // Handle connection errors
      jitsiApi.addEventListener('errorOccurred', (error: any) => {
        console.error('Jitsi error occurred:', error);
        if (error.error?.name === 'conference.connectionError') {
          setError('Connection failed. Please check your internet and try again.');
          setIsLoading(false);
        }
      });

      setApi(jitsiApi);
    } catch (error) {
      console.error('Error creating Jitsi API:', error);
      setError('Failed to initialize video call. Please try again.');
      setIsLoading(false);
    }
  }, [onClose, toast]);

  const initJitsi = useCallback(async (roomName: string) => {
    console.log('Initializing Jitsi with room:', roomName);
    setIsLoading(true);
    setError(null);
    setCurrentRoomName(roomName);

    try {
      await loadJitsiScript();
      
      // Wait a bit for the container to be fully rendered
      await new Promise(resolve => setTimeout(resolve, 100));
      
      if (jitsiContainerRef.current) {
        startJitsiMeeting(roomName);
      } else {
        console.error('Jitsi container ref not found after delay');
        setError('Video container not ready. Please try again.');
        setIsLoading(false);
      }
    } catch (err: any) {
      console.error('Failed to initialize Jitsi:', err);
      setError(err.message || 'Failed to load video call. Please try again.');
      setIsLoading(false);
      toast({
        title: "Error",
        description: err.message || "Failed to load video call. Please check your internet connection.",
        variant: "destructive"
      });
    }
  }, [startJitsiMeeting, toast]);

  const retryConnection = () => {
    if (currentRoomName) {
      initJitsi(currentRoomName);
    }
  };

  const leaveCall = () => {
    if (api) {
      api.dispose();
      setApi(null);
    }
    setIsJoined(false);
    setIsLoading(false);
    setError(null);
    setCurrentRoomName(null);
    initAttempted.current = false;
    onClose();
  };

  const toggleCamera = () => {
    if (api) {
      api.executeCommand('toggleVideo');
    }
  };

  const toggleMic = () => {
    if (api) {
      api.executeCommand('toggleAudio');
    }
  };

  useEffect(() => {
    if (isOpen && !initAttempted.current) {
      initAttempted.current = true;
      let roomName: string;
      if (roomUrl) {
        const urlParts = roomUrl.split('/');
        roomName = urlParts[urlParts.length - 1];
      } else {
        roomName = createRoom();
      }
      
      // Small delay to ensure dialog content is mounted
      const timer = setTimeout(() => {
        initJitsi(roomName);
      }, 300);

      return () => clearTimeout(timer);
    }

    if (!isOpen) {
      // Reset state when dialog closes
      if (api) {
        api.dispose();
        setApi(null);
      }
      setIsJoined(false);
      setIsLoading(false);
      setError(null);
      setParticipants([]);
      setCurrentRoomName(null);
      initAttempted.current = false;
    }
  }, [isOpen, roomUrl, createRoom, initJitsi, api]);

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-7xl max-h-[95vh] w-[95vw] md:w-full bg-gradient-to-br from-background via-background/95 to-primary/5 border-2 border-primary/30 shadow-2xl backdrop-blur-xl rounded-2xl md:rounded-3xl overflow-hidden">
        <DialogHeader className="space-y-4 pb-2">
          <DialogTitle className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="relative p-3 bg-gradient-to-br from-primary/20 to-secondary/20 rounded-2xl shadow-lg">
                <Video className="h-6 w-6 text-primary" />
                <div className="absolute -top-1 -right-1 w-4 h-4 bg-gradient-to-r from-green-400 to-green-500 rounded-full animate-pulse shadow-lg" />
              </div>
              <div>
                <span className="text-2xl font-bold bg-gradient-to-r from-primary via-primary/80 to-secondary bg-clip-text text-transparent">
                  Video Call
                </span>
                <p className="text-sm text-muted-foreground mt-1">High-quality video conference</p>
              </div>
            </div>
            {participants.length > 0 && (
              <div className="flex items-center gap-3 px-4 py-2 bg-gradient-to-r from-green-500/10 to-emerald-500/10 rounded-full border border-green-500/20 animate-fade-in">
                <div className="flex -space-x-2">
                  {Array.from({ length: Math.min(participants.length + 1, 3) }).map((_, i) => (
                    <div key={i} className="w-8 h-8 bg-gradient-to-br from-primary to-secondary rounded-full border-2 border-background flex items-center justify-center text-xs font-bold text-white shadow-lg">
                      {i + 1}
                    </div>
                  ))}
                  {participants.length > 2 && (
                    <div className="w-8 h-8 bg-gradient-to-br from-muted to-muted/80 rounded-full border-2 border-background flex items-center justify-center text-xs font-bold text-foreground shadow-lg">
                      +{participants.length - 2}
                    </div>
                  )}
                </div>
                <span className="text-sm font-semibold text-green-600 dark:text-green-400">
                  {participants.length + 1} online
                </span>
              </div>
            )}
          </DialogTitle>
        </DialogHeader>
        
        <div className="space-y-4 md:space-y-6">
          <div className="relative overflow-hidden rounded-xl md:rounded-2xl bg-gradient-to-br from-secondary/30 to-background border-2 border-primary/20 shadow-2xl">
            <div ref={jitsiContainerRef} className="w-full h-[300px] md:h-[500px] bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 rounded-xl md:rounded-2xl overflow-hidden" />
            {!isJoined && (
              <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-background/95 via-background/90 to-primary/10 backdrop-blur-lg rounded-xl md:rounded-2xl">
                <div className="text-center space-y-4 md:space-y-6 px-4">
                  {error ? (
                    <>
                      <div className="w-16 h-16 md:w-24 md:h-24 mx-auto bg-gradient-to-br from-destructive/30 to-destructive/10 rounded-full flex items-center justify-center shadow-2xl">
                        <VideoOff className="h-8 w-8 md:h-12 md:w-12 text-destructive" />
                      </div>
                      <div className="space-y-2 md:space-y-3">
                        <p className="text-lg md:text-xl font-bold text-destructive">Connection Failed</p>
                        <p className="text-xs md:text-sm text-muted-foreground max-w-sm mx-auto">
                          {error}
                        </p>
                      </div>
                      <Button
                        onClick={retryConnection}
                        className="mt-4"
                        disabled={isLoading}
                      >
                        <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
                        Try Again
                      </Button>
                    </>
                  ) : (
                    <>
                      <div className="relative">
                        <div className="w-16 h-16 md:w-24 md:h-24 mx-auto bg-gradient-to-br from-primary/30 to-secondary/30 rounded-full flex items-center justify-center shadow-2xl animate-pulse">
                          <Video className="h-8 w-8 md:h-12 md:w-12 text-primary" />
                        </div>
                        <div className="absolute inset-0 w-16 h-16 md:w-24 md:h-24 mx-auto rounded-full border-4 border-primary/30 animate-ping" />
                      </div>
                      <div className="space-y-2 md:space-y-3">
                        <p className="text-lg md:text-xl font-bold text-foreground">Connecting to call...</p>
                        <p className="text-xs md:text-sm text-muted-foreground max-w-sm mx-auto">
                          Please wait while we establish the connection. This may take a few moments.
                        </p>
                      </div>
                      <div className="flex justify-center">
                        <div className="flex space-x-1 md:space-x-2">
                          <div className="w-2 h-2 md:w-3 md:h-3 bg-gradient-to-r from-primary to-secondary rounded-full animate-bounce [animation-delay:-0.3s]" />
                          <div className="w-2 h-2 md:w-3 md:h-3 bg-gradient-to-r from-primary to-secondary rounded-full animate-bounce [animation-delay:-0.15s]" />
                          <div className="w-2 h-2 md:w-3 md:h-3 bg-gradient-to-r from-primary to-secondary rounded-full animate-bounce" />
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
          
          {isJoined && (
            <div className="flex flex-wrap justify-center gap-2 md:gap-4 p-4 md:p-6 bg-gradient-to-r from-secondary/20 via-background/50 to-secondary/20 rounded-xl md:rounded-2xl backdrop-blur-sm border border-primary/20 shadow-xl">
              <Button
                variant={isCameraOn ? "default" : "destructive"}
                size="sm"
                onClick={toggleCamera}
                className="relative overflow-hidden group hover:scale-105 transition-all duration-300 shadow-xl h-10 md:h-14 px-3 md:px-6 rounded-xl md:rounded-2xl font-semibold flex-1 md:flex-none min-w-[80px] md:min-w-[120px]"
              >
                <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-700" />
                <div className="flex items-center gap-1 md:gap-2">
                  {isCameraOn ? <Video className="h-4 w-4 md:h-6 md:w-6" /> : <VideoOff className="h-4 w-4 md:h-6 md:w-6" />}
                  <span className="text-xs md:text-sm">{isCameraOn ? 'Camera' : 'Off'}</span>
                </div>
              </Button>
              
              <Button
                variant={isMicOn ? "default" : "destructive"}
                size="sm"
                onClick={toggleMic}
                className="relative overflow-hidden group hover:scale-105 transition-all duration-300 shadow-xl h-10 md:h-14 px-3 md:px-6 rounded-xl md:rounded-2xl font-semibold flex-1 md:flex-none min-w-[80px] md:min-w-[120px]"
              >
                <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-700" />
                <div className="flex items-center gap-1 md:gap-2">
                  {isMicOn ? <Mic className="h-4 w-4 md:h-6 md:w-6" /> : <MicOff className="h-4 w-4 md:h-6 md:w-6" />}
                  <span className="text-xs md:text-sm">{isMicOn ? 'Mic' : 'Off'}</span>
                </div>
              </Button>
              
              <Button
                variant="destructive"
                size="sm"
                onClick={leaveCall}
                className="relative overflow-hidden group hover:scale-105 transition-all duration-300 shadow-xl bg-gradient-to-r from-red-500 via-red-600 to-red-700 hover:from-red-600 hover:to-red-800 h-10 md:h-14 px-3 md:px-6 rounded-xl md:rounded-2xl font-semibold w-full md:w-auto"
              >
                <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-700" />
                <div className="flex items-center gap-1 md:gap-2">
                  <PhoneOff className="h-4 w-4 md:h-6 md:w-6" />
                  <span className="text-xs md:text-sm">Leave Call</span>
                </div>
              </Button>
            </div>
          )}
          
          {roomUrl && (
            <div className="p-6 bg-gradient-to-r from-primary/5 via-background/50 to-secondary/5 rounded-2xl border border-primary/30 animate-fade-in shadow-lg">
              <div className="flex items-start gap-3 mb-4">
                <div className="p-2 bg-primary/20 rounded-lg">
                  <svg className="h-5 w-5 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.367 2.684 3 3 0 00-5.367-2.684z" />
                  </svg>
                </div>
                <div className="flex-1">
                  <p className="font-semibold text-foreground mb-1">Invite Others</p>
                  <p className="text-sm text-muted-foreground">Share this link to invite others to join the call</p>
                </div>
              </div>
              <div className="flex items-center gap-3 p-3 bg-secondary/50 rounded-xl border border-primary/20">
                <code className="flex-1 p-3 bg-background/80 rounded-lg text-sm font-mono break-all border border-primary/10 text-foreground">{roomUrl}</code>
                <Button
                  size="sm"
                  onClick={() => {
                    navigator.clipboard.writeText(roomUrl);
                    toast({
                      title: "✅ Link copied!",
                      description: "Invite link copied to clipboard successfully",
                    });
                  }}
                  className="hover:scale-105 transition-transform duration-200 px-4 py-2 rounded-lg font-medium shadow-md"
                >
                  Copy Link
                </Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};