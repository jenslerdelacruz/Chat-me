import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { Send, Image, User, Plus, Settings, LogOut, UserPlus, ArrowLeft, Video, MessageCircle, Phone, PhoneOff } from 'lucide-react';
import { VideoCall } from '@/components/VideoCall';
import { Badge } from '@/components/ui/badge';

interface Message {
  id: string;
  content: string | null;
  image_url?: string | null;
  message_type: 'text' | 'image' | 'call_info';
  created_at: string;
  sender_id: string;
  conversation_id: string;
  sender_profile?: {
    display_name: string;
    avatar_url?: string;
  };
}

interface Conversation {
  id: string;
  name?: string;
  is_group: boolean;
  created_at: string;
  participants?: Profile[];
}

interface Profile {
  id: string;
  user_id: string;
  username: string;
  display_name: string;
  avatar_url?: string;
  last_seen?: string;
}

interface IncomingCall {
  roomUrl: string;
  caller: Profile;
  conversationId: string;
  callId?: string;
}

const Chat = () => {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConversation, setSelectedConversation] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [searchUsers, setSearchUsers] = useState('');
  const [foundUsers, setFoundUsers] = useState<Profile[]>([]);
  const [showAddUser, setShowAddUser] = useState(false);
  const [onlineUsers, setOnlineUsers] = useState<Set<string>>(new Set());
  const [showVideoCall, setShowVideoCall] = useState(false);
  const [videoCallUrl, setVideoCallUrl] = useState<string>('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null);
  const [userProfile, setUserProfile] = useState<Profile | null>(null);

  useEffect(() => {
    if (user) {
      fetchUserProfile();
      fetchConversations();
      updateUserPresence();
      subscribeToPresence();
      subscribeToCalls();
    }
  }, [user]);

  useEffect(() => {
    if (selectedConversation) {
      fetchMessages();
      const subscription = subscribeToMessages();
      return () => { subscription.unsubscribe(); };
    }
  }, [selectedConversation]);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const fetchUserProfile = async () => {
    if (!user) return;
    try {
      const { data, error } = await supabase.from('profiles').select('*').eq('user_id', user.id).single();
      if (error) throw error;
      setUserProfile(data);
    } catch (error) {
      console.error("Error fetching user profile:", error);
    }
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const updateUserPresence = async () => {
    if (!user) return;
    try {
      await supabase.from('profiles').update({ last_seen: new Date().toISOString() }).eq('user_id', user.id);
    } catch (error) {
      console.error('Error updating presence:', error);
    }
  };

  const subscribeToPresence = () => {
    const channel = supabase.channel('presence');
    channel.on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, () => {
      fetchOnlineUsers();
    }).subscribe();
    fetchOnlineUsers();
    return () => { supabase.removeChannel(channel); };
  };

  const subscribeToCalls = () => {
    if (!user) return () => {};
    const channel = supabase.channel(`calls-${user.id}`);
    channel.on('broadcast', { event: 'incoming_call' }, ({ payload }) => {
      if (payload.caller.user_id !== user.id) {
        setIncomingCall(payload);
        setTimeout(() => {
          setIncomingCall(prev => {
            if (prev && prev.callId === payload.callId) {
              toast({ title: "Missed Call", description: `You missed a call from ${payload.caller.display_name}` });
              return null;
            }
            return prev;
          });
        }, 30000);
      }
    }).on('broadcast', { event: 'call_ended' }, () => {
      setIncomingCall(null);
      setShowVideoCall(false);
    }).subscribe();
    return () => { supabase.removeChannel(channel); };
  };

  const fetchOnlineUsers = async () => {
    try {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const { data } = await supabase.from('profiles').select('user_id').gte('last_seen', fiveMinutesAgo);
      setOnlineUsers(new Set(data?.map(p => p.user_id) || []));
    } catch (error) {
      console.error('Error fetching online users:', error);
    }
  };

  const fetchConversations = async () => {
    try {
      const { data, error } = await supabase.from('conversation_participants').select(`conversation_id, conversations!inner ( id, name, is_group, created_at )`).eq('user_id', user?.id);
      if (error) throw error;
      const convos = data?.map(item => item.conversations).filter(Boolean) || [];
      const conversationsWithParticipants: Conversation[] = await Promise.all(
        convos.map(async (conv: any) => {
          const { data: participantData } = await supabase.from('conversation_participants').select('user_id').eq('conversation_id', conv.id);
          const userIds = participantData?.map(p => p.user_id) || [];
          const { data: profilesData } = await supabase.from('profiles').select('id, user_id, username, display_name, avatar_url, last_seen').in('user_id', userIds);
          return { ...conv, participants: profilesData || [] } as Conversation;
        })
      );
      setConversations(conversationsWithParticipants);
      if (conversationsWithParticipants.length > 0 && !selectedConversation) {
        setSelectedConversation(conversationsWithParticipants[0].id);
      }
    } catch (error: any) {
      console.error("Error loading conversations:", error.message);
    }
  };

  const fetchMessages = async () => {
    if (!selectedConversation) return;
    try {
      const { data: messagesData, error } = await supabase.from('messages').select('*').eq('conversation_id', selectedConversation).order('created_at', { ascending: true });
      if (error) throw error;
      const senderIds = [...new Set(messagesData?.map(m => m.sender_id) || [])];
      const { data: profilesData } = await supabase.from('profiles').select('user_id, display_name, avatar_url').in('user_id', senderIds);
      const messagesWithProfiles = messagesData?.map(message => ({ ...message, message_type: message.message_type as 'text' | 'image' | 'call_info', sender_profile: profilesData?.find(p => p.user_id === message.sender_id) })) || [];
      setMessages(messagesWithProfiles as Message[]);
    } catch (error: any) {
      console.error("Error loading messages:", error.message);
    }
  };

  const subscribeToMessages = () => {
    return supabase.channel(`messages-${selectedConversation}`).on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${selectedConversation}` },
      async (payload) => {
        const newMessagePayload = payload.new as any;
        const { data: profileData } = await supabase.from('profiles').select('user_id, display_name, avatar_url').eq('user_id', newMessagePayload.sender_id).single();
        const messageWithProfile: Message = { ...newMessagePayload, message_type: newMessagePayload.message_type as 'text' | 'image' | 'call_info', sender_profile: profileData };
        setMessages(prevMessages => {
          const exists = prevMessages.some(msg => msg.id === messageWithProfile.id);
          if (exists) return prevMessages;
          return [...prevMessages, messageWithProfile];
        });
      }
    ).subscribe();
  };

  const sendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMessage.trim() || !selectedConversation || !user) return;
    setIsLoading(true);
    try {
      await updateUserPresence();
      const { error } = await supabase.from('messages').insert({ conversation_id: selectedConversation, sender_id: user.id, content: newMessage, message_type: 'text' });
      if (error) throw error;
      setNewMessage('');
    } catch (error: any) {
      console.error("Failed to send message:", error.message);
    } finally {
      setIsLoading(false);
    }
  };

  const uploadImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !selectedConversation || !user) return;
    if (!file.type.startsWith('image/')) {
      console.error("Invalid file type: Please select an image file.");
      return;
    }
    if (file.size > 10 * 1024 * 1024) { // 10MB limit
      toast({ title: "File too large", description: "Please select an image smaller than 10MB.", variant: "destructive" });
      return;
    }
    setIsLoading(true);
    try {
      await updateUserPresence();
      const fileExt = file.name.split('.').pop();
      const fileName = `${user.id}/${Date.now()}.${fileExt}`;
      const { error: uploadError } = await supabase.storage.from('chat-images').upload(fileName, file);
      if (uploadError) throw uploadError;
      const { data } = supabase.storage.from('chat-images').getPublicUrl(fileName);
      const { error: messageError } = await supabase.from('messages').insert({ conversation_id: selectedConversation, sender_id: user.id, image_url: data.publicUrl, message_type: 'image' });
      if (messageError) throw messageError;
      console.log("Image sent successfully");
    } catch (error: any) {
      console.error("Failed to send image:", error.message);
    } finally {
      setIsLoading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const searchForUsers = async (searchTerm: string) => {
    if (!searchTerm.trim() || !user) { setFoundUsers([]); return; }
    const sanitizedTerm = searchTerm.trim().slice(0, 100).replace(/[%_\\]/g, '\\$&');
    try {
      const { data, error } = await supabase.from('profiles').select('*').or(`username.ilike.%${sanitizedTerm}%,display_name.ilike.%${sanitizedTerm}%`).neq('user_id', user.id).limit(10);
      if (error) throw error;
      setFoundUsers(data || []);
    } catch (error: any) {
      console.error('User search error:', error.message);
    }
  };

  const createConversationWithUser = async (otherUser: Profile) => {
    if (!user) return;
    try {
      const { data: conversation, error: convError } = await supabase.from('conversations').insert({ name: `Chat with ${otherUser.display_name}`, is_group: false, created_by: user.id }).select().single();
      if (convError) throw convError;
      const { error: participantError } = await supabase.from('conversation_participants').insert([{ conversation_id: conversation.id, user_id: user.id }, { conversation_id: conversation.id, user_id: otherUser.user_id }]);
      if (participantError) throw participantError;
      console.log(`Started a chat with ${otherUser.display_name}`);
      setShowAddUser(false);
      setSearchUsers('');
      setFoundUsers([]);
      await fetchConversations();
      setSelectedConversation(conversation.id);
    } catch (error: any) {
      console.error("Failed to create chat:", error.message);
    }
  };

  const handleSignOut = async () => {
    const { error } = await signOut();
    if (error) { console.error("Sign out failed:", error.message); }
    else { navigate('/'); }
  };

  const getConversationName = (conversation: Conversation) => {
    if (conversation.is_group) return conversation.name || 'Group Chat';
    const otherParticipant = conversation.participants?.find(p => p.user_id !== user?.id);
    return otherParticipant?.display_name || 'Unknown User';
  };

  const getCurrentConversation = () => conversations.find(c => c.id === selectedConversation);
  const isUserOnline = (userId: string) => onlineUsers.has(userId);

  const startVideoCall = async () => {
    if (!selectedConversation || !userProfile || !user) return;
    const currentConv = getCurrentConversation();
    const otherParticipants = currentConv?.participants?.filter(p => p.user_id !== user.id);
    if (!otherParticipants || otherParticipants.length === 0) {
      console.error("Cannot start call: No other participants in this chat.");
      return;
    }
    const roomName = `chatapp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const jitsiRoomUrl = `https://meet.jit.si/${roomName}`;
    const callId = `call-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    setVideoCallUrl(jitsiRoomUrl);
    setShowVideoCall(true);
    for (const participant of otherParticipants) {
      const channel = supabase.channel(`calls-${participant.user_id}`);
      await channel.send({ type: 'broadcast', event: 'incoming_call', payload: { roomUrl: jitsiRoomUrl, caller: userProfile, conversationId: selectedConversation, callId } });
    }
    await supabase.from('messages').insert({ conversation_id: selectedConversation, sender_id: user.id, content: `Started a video call.`, message_type: 'call_info' });
  };

  const acceptCall = () => {
    if (incomingCall) {
      setVideoCallUrl(incomingCall.roomUrl);
      setSelectedConversation(incomingCall.conversationId);
      setShowVideoCall(true);
      setIncomingCall(null);
    }
  };

  const declineCall = () => { setIncomingCall(null); };

  const endCall = async () => {
    if (!selectedConversation || !user) return;
    const currentConv = getCurrentConversation();
    const otherParticipants = currentConv?.participants?.filter(p => p.user_id !== user.id);
    for (const participant of otherParticipants || []) {
      const channel = supabase.channel(`calls-${participant.user_id}`);
      await channel.send({ type: 'broadcast', event: 'call_ended', payload: { callerId: user.id, conversationId: selectedConversation } });
    }
    setShowVideoCall(false);
    setVideoCallUrl('');
    setIncomingCall(null);
  };

  const selectedConv = getCurrentConversation();
  const otherUser = selectedConv?.participants?.find(p => p.user_id !== user?.id);

  return (
    <div className="h-screen flex flex-col bg-gradient-to-br from-background via-secondary/5 to-primary/5 overflow-hidden">
      {/* ... (Dito mo ilalagay ang JSX/HTML. Walang pagbabago dito, kaya't pinaikli ko para hindi humaba) ... */}
      <div className="h-screen flex flex-col bg-gradient-to-br from-background via-secondary/5 to-primary/5 overflow-hidden">
        {/* Mobile Header */}
        <div className="lg:hidden border-b border-primary/20 bg-gradient-to-r from-background via-primary/5 to-secondary/5 backdrop-blur-sm p-4 flex items-center justify-between shadow-lg">
          {selectedConversation && selectedConv ? (
            <>
              <div className="flex items-center space-x-3">
                <Button variant="ghost" size="sm" onClick={() => setSelectedConversation(null)} className="p-2 hover:bg-primary/10 hover:scale-110 transition-all duration-300">
                  <ArrowLeft className="h-5 w-5 text-primary" />
                </Button>
                <div className="flex items-center space-x-3">
                  <div className="relative">
                    <Avatar className="h-10 w-10 border-2 border-primary/20 shadow-lg">
                      <AvatarImage src={selectedConv?.participants?.find(p => p.user_id !== user?.id)?.avatar_url} />
                      <AvatarFallback className="bg-gradient-to-br from-primary/20 to-secondary/20 text-primary font-semibold">
                        <User className="h-5 w-5" />
                      </AvatarFallback>
                    </Avatar>
                    {!selectedConv.is_group && selectedConv.participants?.some(p => p.user_id !== user?.id && isUserOnline(p.user_id)) && (
                      <div className="absolute -top-1 -right-1 w-3 h-3 bg-green-500 rounded-full border-2 border-background animate-pulse" />
                    )}
                  </div>
                  <div>
                    <h2 className="font-semibold text-foreground">{getConversationName(selectedConv)}</h2>
                    {!selectedConv.is_group && selectedConv.participants?.some(p => p.user_id !== user?.id && isUserOnline(p.user_id)) && (
                      <p className="text-xs text-green-600 font-medium flex items-center gap-1">
                        <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" /> Online
                      </p>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex space-x-2">
                <Button variant="ghost" size="sm" onClick={startVideoCall} disabled={!selectedConv.participants?.some(p => p.user_id !== user?.id)} className="hover:bg-primary/10 hover:scale-110 transition-all duration-300 text-primary">
                  <Video className="h-5 w-5" />
                </Button>
                <Button variant="ghost" size="sm" onClick={() => navigate('/dashboard')} className="hover:bg-primary/10 hover:scale-110 transition-all duration-300 text-primary">
                  <Settings className="h-5 w-5" />
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 bg-gradient-to-br from-primary to-secondary rounded-lg flex items-center justify-center"> <span className="text-white font-bold text-sm">C</span> </div>
                <h1 className="text-xl font-bold bg-gradient-to-r from-primary to-secondary bg-clip-text text-transparent">ChatApp</h1>
              </div>
              <div className="flex items-center space-x-2">
                <Button variant="ghost" size="sm" onClick={() => navigate('/dashboard')} className="hover:bg-primary/10 hover:scale-110 transition-all duration-300 text-primary">
                  <Settings className="h-5 w-5" />
                </Button>
                <Button variant="ghost" size="sm" onClick={handleSignOut} className="hover:bg-destructive/10 hover:scale-110 transition-all duration-300 text-destructive">
                  <LogOut className="h-5 w-5" />
                </Button>
              </div>
            </>
          )}
        </div>

        {/* Desktop Header */}
        <div className="hidden lg:block border-b border-primary/20 bg-gradient-to-r from-background via-primary/5 to-secondary/5 backdrop-blur-sm p-6 shadow-lg">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="w-10 h-10 bg-gradient-to-br from-primary to-secondary rounded-xl flex items-center justify-center shadow-lg"><span className="text-white font-bold text-lg">C</span></div>
              <h1 className="text-2xl font-bold bg-gradient-to-r from-primary to-secondary bg-clip-text text-transparent">ChatApp</h1>
            </div>
            <div className="flex items-center space-x-3">
              <Button variant="ghost" size="sm" onClick={() => navigate('/dashboard')} className="hover:bg-primary/10 hover:scale-110 transition-all duration-300 text-primary">
                <Settings className="h-5 w-5 mr-2" /> Profile
              </Button>
              <Button variant="ghost" size="sm" onClick={handleSignOut} className="hover:bg-destructive/10 hover:scale-110 transition-all duration-300 text-destructive">
                <LogOut className="h-5 w-5 mr-2" /> Sign Out
              </Button>
            </div>
          </div>
        </div>

        <div className="flex-1 flex bg-gradient-to-br from-background to-secondary/10 overflow-hidden">
          {/* Sidebar */}
          <div className={`lg:w-80 lg:block border-r border-primary/20 bg-gradient-to-b from-secondary/20 via-background to-secondary/10 backdrop-blur-sm ${selectedConversation ? 'hidden lg:block' : 'w-full block'}`}>
            <div className="p-6 border-b border-primary/20 bg-gradient-to-r from-background to-primary/5">
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-bold bg-gradient-to-r from-primary to-secondary bg-clip-text text-transparent">Conversations</h2>
                <Dialog open={showAddUser} onOpenChange={setShowAddUser}>
                  <DialogTrigger asChild>
                    <Button size="sm" variant="outline" className="border-primary/20 hover:bg-primary/10 hover:scale-110 transition-all duration-300">
                      <UserPlus className="h-4 w-4 text-primary" />
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="mx-4 bg-gradient-to-br from-background via-secondary/5 to-primary/5 border-primary/20">
                    <DialogHeader>
                      <DialogTitle className="text-xl font-bold bg-gradient-to-r from-primary to-secondary bg-clip-text text-transparent">Start a chat with someone</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4">
                      <Input placeholder="Search users..." value={searchUsers} onChange={(e) => { setSearchUsers(e.target.value); searchForUsers(e.target.value); }} className="border-primary/20 focus:border-primary/40 focus:ring-primary/20" />
                      <ScrollArea className="h-60">
                        <div className="space-y-2">
                          {foundUsers.map((profile) => (
                            <Card key={profile.id} className="cursor-pointer hover:bg-primary/10 hover:scale-105 transition-all duration-300 border-primary/10 bg-gradient-to-r from-background to-secondary/5" onClick={() => createConversationWithUser(profile)}>
                              <CardContent className="p-4">
                                <div className="flex items-center space-x-3">
                                  <div className="relative">
                                    <Avatar className="h-10 w-10 border-2 border-primary/20 shadow-lg">
                                      <AvatarImage src={profile.avatar_url} />
                                      <AvatarFallback className="bg-gradient-to-br from-primary/20 to-secondary/20 text-primary font-semibold"><User className="h-5 w-5" /></AvatarFallback>
                                    </Avatar>
                                    {isUserOnline(profile.user_id) && <div className="absolute -top-1 -right-1 w-3 h-3 bg-green-500 rounded-full border-2 border-background animate-pulse" />}
                                  </div>
                                  <div className="flex-1">
                                    <div className="flex items-center space-x-2">
                                      <p className="font-semibold text-foreground">{profile.display_name}</p>
                                      {isUserOnline(profile.user_id) && <Badge variant="secondary" className="text-xs bg-green-100 text-green-800 border border-green-200">Online</Badge>}
                                    </div>
                                    <p className="text-sm text-muted-foreground">@{profile.username}</p>
                                  </div>
                                </div>
                              </CardContent>
                            </Card>
                          ))}
                          {searchUsers && foundUsers.length === 0 && (
                            <div className="text-center py-8">
                              <User className="h-12 w-12 mx-auto text-muted-foreground mb-3" />
                              <p className="text-muted-foreground font-medium">No users found</p>
                              <p className="text-sm text-muted-foreground">Try searching with a different term</p>
                            </div>
                          )}
                        </div>
                      </ScrollArea>
                    </div>
                  </DialogContent>
                </Dialog>
              </div>
            </div>
            <ScrollArea className="h-[calc(100vh-200px)]">
              <div className="p-4 space-y-3">
                {conversations.map((conversation) => {
                  const otherParticipant = conversation.participants?.find(p => p.user_id !== user?.id);
                  const isOnline = otherParticipant && isUserOnline(otherParticipant.user_id);
                  return (
                    <Card key={conversation.id} className={`cursor-pointer transition-all duration-300 hover:scale-105 border-primary/10 ${selectedConversation === conversation.id ? 'bg-gradient-to-r from-primary/10 to-secondary/5 border-primary/30 shadow-lg' : 'hover:bg-primary/5 hover:border-primary/20 bg-gradient-to-r from-background to-secondary/5'}`} onClick={() => setSelectedConversation(conversation.id)}>
                      <CardContent className="p-4">
                        <div className="flex items-center space-x-3">
                          <div className="relative">
                            <Avatar className="h-12 w-12 border-2 border-primary/20 shadow-lg">
                              <AvatarImage src={otherParticipant?.avatar_url} />
                              <AvatarFallback className="bg-gradient-to-br from-primary/20 to-secondary/20 text-primary font-semibold"><User className="h-6 w-6" /></AvatarFallback>
                            </Avatar>
                            {!conversation.is_group && isOnline && <div className="absolute -top-1 -right-1 w-4 h-4 bg-green-500 rounded-full border-2 border-background animate-pulse" />}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between">
                              <h3 className="font-semibold truncate text-foreground text-base">{getConversationName(conversation)}</h3>
                              {!conversation.is_group && isOnline && <Badge variant="secondary" className="text-xs bg-green-100 text-green-800 border border-green-200 ml-2">Online</Badge>}
                            </div>
                            <p className="text-sm text-muted-foreground">{conversation.is_group ? '👥 Group Chat' : '💬 Direct Message'}</p>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
                {conversations.length === 0 && (
                  <div className="text-center py-12">
                    <MessageCircle className="h-16 w-16 mx-auto text-muted-foreground mb-4 opacity-50" />
                    <p className="text-muted-foreground font-medium mb-2">No conversations yet</p>
                    <p className="text-sm text-muted-foreground">Start chatting by adding a new contact</p>
                  </div>
                )}
              </div>
            </ScrollArea>
          </div>
          <div className={`flex-1 flex flex-col bg-gradient-to-b from-background to-primary/5 ${!selectedConversation ? 'hidden lg:flex' : 'flex'}`}>
            {selectedConversation && selectedConv ? (
              <>
                <div className="hidden lg:block border-b border-primary/20 p-6 bg-gradient-to-r from-background to-secondary/5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-4">
                      <div className="relative">
                        <Avatar className="h-12 w-12 border-2 border-primary/20 shadow-lg">
                          <AvatarImage src={selectedConv.participants?.find(p => p.user_id !== user?.id)?.avatar_url} />
                          <AvatarFallback className="bg-gradient-to-br from-primary/20 to-secondary/20 text-primary font-semibold"><User className="h-6 w-6" /></AvatarFallback>
                        </Avatar>
                        {!selectedConv.is_group && selectedConv.participants?.some(p => p.user_id !== user?.id && isUserOnline(p.user_id)) && <div className="absolute -top-1 -right-1 w-4 h-4 bg-green-500 rounded-full border-2 border-background animate-pulse" />}
                      </div>
                      <div>
                        <h2 className="font-semibold text-lg text-foreground">{getConversationName(selectedConv)}</h2>
                        {!selectedConv.is_group && selectedConv.participants?.some(p => p.user_id !== user?.id && isUserOnline(p.user_id)) && <p className="text-sm text-green-600 font-medium flex items-center gap-2"><div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />Online</p>}
                      </div>
                    </div>
                    <Button variant="outline" size="sm" onClick={startVideoCall} disabled={!selectedConv.participants?.some(p => p.user_id !== user?.id)} className="border-primary/20 hover:bg-primary/10 hover:scale-110 transition-all duration-300 text-primary">
                      <Video className="h-4 w-4 mr-2" />Video Call
                    </Button>
                  </div>
                </div>
                <ScrollArea className="flex-1 p-6 bg-gradient-to-b from-background/50 to-secondary/5">
                  <div className="space-y-4">
                    {messages.map((message) => (
                      <div key={message.id} className={`flex ${message.sender_id === user?.id ? 'justify-end' : 'justify-start'} animate-fade-in`}>
                        <div className={`flex max-w-[85%] sm:max-w-[70%] ${message.sender_id === user?.id ? 'flex-row-reverse' : 'flex-row'} group`}>
                          <Avatar className="h-11 w-11 mx-3 flex-shrink-0 border-3 border-primary/30 shadow-xl hover:scale-110 transition-all duration-300">
                            <AvatarImage src={message.sender_profile?.avatar_url} />
                            <AvatarFallback className="bg-gradient-to-br from-primary/30 to-secondary/30 text-primary font-bold text-lg"><User className="h-6 w-6" /></AvatarFallback>
                          </Avatar>
                          <div className={`relative rounded-3xl p-5 shadow-xl backdrop-blur-sm border-2 hover:scale-[1.02] transition-all duration-300 ${
                            message.sender_id === user?.id 
                              ? 'bg-gradient-to-br from-primary via-primary/90 to-primary/80 text-primary-foreground border-primary/20 shadow-primary/20' 
                              : 'bg-gradient-to-br from-background via-secondary/10 to-secondary/20 border-primary/20 text-foreground shadow-secondary/20'
                          }`}>
                            <div className="absolute inset-0 bg-gradient-to-br from-white/10 to-transparent rounded-3xl opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                            <div className="relative z-10">
                              <div className="flex items-center justify-between mb-3">
                                <p className="text-xs font-bold opacity-80 tracking-wider uppercase">{message.sender_profile?.display_name}</p>
                                <p className="text-xs opacity-60">{new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
                              </div>
                              {message.message_type === 'text' && (
                                <p className="break-words text-base leading-relaxed font-medium">{message.content}</p>
                              )}
                              {message.message_type === 'image' && (
                                <div className="relative overflow-hidden rounded-2xl shadow-lg">
                                  <img 
                                    src={message.image_url!} 
                                    alt="Shared" 
                                    className="max-w-full max-h-80 h-auto cursor-pointer hover:scale-110 transition-all duration-500 rounded-2xl" 
                                    onClick={() => window.open(message.image_url!, '_blank')} 
                                  />
                                  <div className="absolute inset-0 bg-gradient-to-t from-black/20 to-transparent opacity-0 hover:opacity-100 transition-opacity duration-300 rounded-2xl" />
                                </div>
                              )}
                              {message.message_type === 'call_info' && (
                                <div className="flex items-center justify-center gap-2 p-3 bg-gradient-to-r from-primary/20 to-secondary/20 rounded-2xl border border-primary/30">
                                  <Video className="h-4 w-4 text-primary" />
                                  <p className="text-sm font-semibold text-center">{message.content}</p>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                    <div ref={messagesEndRef} />
                  </div>
                </ScrollArea>
                <div className="p-6 border-t-2 border-primary/20 bg-gradient-to-r from-background via-secondary/5 to-background backdrop-blur-sm">
                  <form onSubmit={sendMessage} className="flex items-center space-x-4">
                    <div className="flex-1 relative">
                      <Input 
                        value={newMessage} 
                        onChange={(e) => setNewMessage(e.target.value)} 
                        placeholder="Type your message..." 
                        disabled={isLoading} 
                        className="w-full border-2 border-primary/30 focus:border-primary/60 focus:ring-4 focus:ring-primary/20 rounded-2xl py-4 px-6 text-base bg-gradient-to-r from-background to-secondary/10 shadow-lg backdrop-blur-sm hover:shadow-xl transition-all duration-300 font-medium placeholder:text-muted-foreground/60" 
                      />
                      <div className="absolute inset-0 rounded-2xl bg-gradient-to-r from-primary/5 to-secondary/5 pointer-events-none opacity-0 hover:opacity-100 transition-opacity duration-300" />
                    </div>
                    <input ref={fileInputRef} type="file" accept="image/*" onChange={uploadImage} className="hidden" />
                    <Button 
                      type="button" 
                      size="icon" 
                      variant="outline" 
                      onClick={() => fileInputRef.current?.click()} 
                      disabled={isLoading} 
                      className="border-2 border-primary/30 hover:bg-primary/20 hover:scale-110 transition-all duration-300 text-primary rounded-2xl h-12 w-12 shadow-lg hover:shadow-xl"
                    >
                      <Image className="h-6 w-6" />
                    </Button>
                    <Button 
                      type="submit" 
                      disabled={isLoading || !newMessage.trim()} 
                      className="bg-gradient-to-r from-primary via-primary/90 to-primary/80 hover:from-primary/90 hover:to-primary text-white rounded-2xl px-8 py-3 hover:scale-110 transition-all duration-300 shadow-xl hover:shadow-2xl font-semibold h-12 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Send className="h-5 w-5 mr-2" />
                      <span className="hidden sm:inline">Send</span>
                    </Button>
                  </form>
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center space-y-4">
                  <MessageCircle className="h-24 w-24 mx-auto text-primary/50" />
                  <h3 className="text-2xl font-bold bg-gradient-to-r from-primary to-secondary bg-clip-text text-transparent">Select a conversation</h3>
                  <p className="text-muted-foreground text-lg">Choose a conversation to start chatting</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Incoming Call Dialog */}
      <Dialog open={!!incomingCall} onOpenChange={() => setIncomingCall(null)}>
        <DialogContent className="w-[95vw] max-w-md mx-auto bg-gradient-to-br from-background via-secondary/5 to-primary/5 border-2 border-primary/30 shadow-2xl backdrop-blur-xl rounded-2xl">
          <DialogHeader className="text-center pb-4">
            <DialogTitle className="text-xl md:text-2xl font-bold bg-gradient-to-r from-primary to-secondary bg-clip-text text-transparent">📞 Incoming Call</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col items-center justify-center p-4 md:p-6 space-y-4 md:space-y-6">
            <div className="relative">
              <Avatar className="h-20 w-20 md:h-24 md:w-24 border-4 border-primary/30 shadow-2xl animate-pulse">
                <AvatarImage src={incomingCall?.caller?.avatar_url} />
                <AvatarFallback className="bg-gradient-to-br from-primary/20 to-secondary/20 text-primary">
                  <User className="h-10 w-10 md:h-12 md:w-12" />
                </AvatarFallback>
              </Avatar>
              <div className="absolute inset-0 rounded-full border-4 border-primary/20 animate-ping" />
            </div>
            <div className="text-center space-y-2">
              <p className="text-lg md:text-xl font-semibold text-foreground">{incomingCall?.caller?.display_name || 'Someone'}</p>
              <p className="text-sm text-muted-foreground">is calling you...</p>
            </div>
            <div className="w-full flex justify-center">
              <div className="flex space-x-1">
                <div className="w-2 h-2 bg-gradient-to-r from-primary to-secondary rounded-full animate-bounce [animation-delay:-0.3s]" />
                <div className="w-2 h-2 bg-gradient-to-r from-primary to-secondary rounded-full animate-bounce [animation-delay:-0.15s]" />
                <div className="w-2 h-2 bg-gradient-to-r from-primary to-secondary rounded-full animate-bounce" />
              </div>
            </div>
          </div>
          <DialogFooter className="flex gap-3 sm:justify-center">
            <Button 
              variant="destructive" 
              size="lg"
              onClick={declineCall}
              className="flex-1 md:flex-none bg-gradient-to-r from-red-500 to-red-600 hover:from-red-600 hover:to-red-700 rounded-2xl h-12 md:h-14 font-semibold shadow-lg hover:scale-105 transition-all duration-300"
            >
              <PhoneOff className="mr-2 h-5 w-5" />
              Decline
            </Button>
            <Button 
              variant="default" 
              size="lg" 
              onClick={acceptCall} 
              className="flex-1 md:flex-none bg-gradient-to-r from-green-500 to-green-600 hover:from-green-600 hover:to-green-700 rounded-2xl h-12 md:h-14 font-semibold shadow-lg hover:scale-105 transition-all duration-300"
            >
              <Phone className="mr-2 h-5 w-5" />
              Accept
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <VideoCall isOpen={showVideoCall} onClose={endCall} roomUrl={videoCallUrl} />
    </div>
  );
};

export default Chat;
