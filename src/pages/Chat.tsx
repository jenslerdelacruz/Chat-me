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
import { Send, Image, User, Settings, LogOut, UserPlus, ArrowLeft, Video, MessageCircle, Phone, PhoneOff, Search, MoreVertical } from 'lucide-react';
import { VideoCall } from '@/components/VideoCall';

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
      toast({ title: "Error loading conversations", description: error.message, variant: "destructive" });
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
      toast({ title: "Error loading messages", description: error.message, variant: "destructive" });
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
      toast({ title: "Failed to send message", description: error.message, variant: "destructive" });
    } finally {
      setIsLoading(false);
    }
  };

  const uploadImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !selectedConversation || !user) return;
    if (!file.type.startsWith('image/')) {
      toast({ title: "Invalid file type", description: "Please select an image file.", variant: "destructive" });
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
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
      toast({ title: "Image sent", description: "Your image has been sent successfully." });
    } catch (error: any) {
      toast({ title: "Failed to send image", description: error.message, variant: "destructive" });
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
      console.error('User search error:', error);
      toast({ title: "Search failed", description: error.message, variant: "destructive" });
    }
  };

  const createConversationWithUser = async (otherUser: Profile) => {
    if (!user) return;
    try {
      const { data: conversation, error: convError } = await supabase.from('conversations').insert({ name: `Chat with ${otherUser.display_name}`, is_group: false, created_by: user.id }).select().single();
      if (convError) throw convError;
      const { error: participantError } = await supabase.from('conversation_participants').insert([{ conversation_id: conversation.id, user_id: user.id }, { conversation_id: conversation.id, user_id: otherUser.user_id }]);
      if (participantError) throw participantError;
      toast({ title: "Chat created", description: `Started a chat with ${otherUser.display_name}` });
      setShowAddUser(false);
      setSearchUsers('');
      setFoundUsers([]);
      await fetchConversations();
      setSelectedConversation(conversation.id);
    } catch (error: any) {
      toast({ title: "Failed to create chat", description: error.message, variant: "destructive" });
    }
  };

  const handleSignOut = async () => {
    const { error } = await signOut();
    if (error) { toast({ title: "Sign out failed", description: error.message, variant: "destructive" }); }
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
      toast({ title: "Cannot start call", description: "No other participants in this chat.", variant: "destructive" });
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
    <div className="h-screen flex bg-background overflow-hidden">
      {/* Sidebar */}
      <div className={`w-full lg:w-96 flex flex-col border-r border-border bg-card ${selectedConversation ? 'hidden lg:flex' : 'flex'}`}>
        {/* Sidebar Header */}
        <div className="p-4 border-b border-border">
          <div className="flex items-center justify-between mb-4">
            <h1 className="text-2xl font-bold text-foreground">Messages</h1>
            <div className="flex items-center gap-2">
              <Dialog open={showAddUser} onOpenChange={setShowAddUser}>
                <DialogTrigger asChild>
                  <Button size="icon" variant="ghost" className="h-9 w-9 rounded-full hover:bg-accent/10">
                    <UserPlus className="h-5 w-5 text-primary" />
                  </Button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-md bg-card border-border">
                  <DialogHeader>
                    <DialogTitle className="text-xl font-semibold">New Conversation</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-4 mt-4">
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                      <Input 
                        placeholder="Search by name or username..." 
                        value={searchUsers} 
                        onChange={(e) => { setSearchUsers(e.target.value); searchForUsers(e.target.value); }} 
                        className="pl-10 bg-muted/50 border-0 focus-visible:ring-1 focus-visible:ring-primary"
                      />
                    </div>
                    <ScrollArea className="h-72">
                      <div className="space-y-1">
                        {foundUsers.map((profile) => (
                          <button 
                            key={profile.id} 
                            className="w-full flex items-center gap-3 p-3 rounded-xl hover:bg-muted/50 transition-colors text-left"
                            onClick={() => createConversationWithUser(profile)}
                          >
                            <div className="relative">
                              <Avatar className="h-11 w-11">
                                <AvatarImage src={profile.avatar_url} />
                                <AvatarFallback className="bg-primary/10 text-primary font-medium">
                                  {profile.display_name?.charAt(0).toUpperCase()}
                                </AvatarFallback>
                              </Avatar>
                              {isUserOnline(profile.user_id) && (
                                <span className="absolute bottom-0 right-0 w-3 h-3 bg-chat-online rounded-full border-2 border-card" />
                              )}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="font-medium text-foreground truncate">{profile.display_name}</p>
                              <p className="text-sm text-muted-foreground truncate">@{profile.username}</p>
                            </div>
                          </button>
                        ))}
                        {searchUsers && foundUsers.length === 0 && (
                          <div className="text-center py-8 text-muted-foreground">
                            <User className="h-10 w-10 mx-auto mb-2 opacity-50" />
                            <p className="text-sm">No users found</p>
                          </div>
                        )}
                      </div>
                    </ScrollArea>
                  </div>
                </DialogContent>
              </Dialog>
              <Button size="icon" variant="ghost" onClick={() => navigate('/dashboard')} className="h-9 w-9 rounded-full hover:bg-accent/10">
                <Settings className="h-5 w-5 text-muted-foreground" />
              </Button>
              <Button size="icon" variant="ghost" onClick={handleSignOut} className="h-9 w-9 rounded-full hover:bg-destructive/10">
                <LogOut className="h-5 w-5 text-muted-foreground" />
              </Button>
            </div>
          </div>
        </div>

        {/* Conversations List */}
        <ScrollArea className="flex-1">
          <div className="p-2">
            {conversations.map((conversation) => {
              const participant = conversation.participants?.find(p => p.user_id !== user?.id);
              const isOnline = participant && isUserOnline(participant.user_id);
              const isSelected = selectedConversation === conversation.id;
              
              return (
                <button
                  key={conversation.id}
                  className={`w-full flex items-center gap-3 p-3 rounded-xl transition-all duration-200 text-left mb-1 ${
                    isSelected 
                      ? 'bg-primary/10 border border-primary/20' 
                      : 'hover:bg-muted/50 border border-transparent'
                  }`}
                  onClick={() => setSelectedConversation(conversation.id)}
                >
                  <div className="relative">
                    <Avatar className="h-12 w-12">
                      <AvatarImage src={participant?.avatar_url} />
                      <AvatarFallback className="bg-primary/10 text-primary font-semibold">
                        {getConversationName(conversation).charAt(0).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    {!conversation.is_group && isOnline && (
                      <span className="absolute bottom-0 right-0 w-3.5 h-3.5 bg-chat-online rounded-full border-2 border-card" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <p className={`font-medium truncate ${isSelected ? 'text-primary' : 'text-foreground'}`}>
                        {getConversationName(conversation)}
                      </p>
                    </div>
                    <p className="text-sm text-muted-foreground truncate">
                      {isOnline ? 'Online' : 'Tap to chat'}
                    </p>
                  </div>
                </button>
              );
            })}
            {conversations.length === 0 && (
              <div className="text-center py-16 px-4">
                <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-muted/50 flex items-center justify-center">
                  <MessageCircle className="h-8 w-8 text-muted-foreground" />
                </div>
                <p className="text-muted-foreground font-medium">No conversations yet</p>
                <p className="text-sm text-muted-foreground mt-1">Start chatting by tapping the + button</p>
              </div>
            )}
          </div>
        </ScrollArea>
      </div>

      {/* Chat Area */}
      <div className={`flex-1 flex flex-col bg-background ${!selectedConversation ? 'hidden lg:flex' : 'flex'}`}>
        {selectedConversation && selectedConv ? (
          <>
            {/* Chat Header */}
            <div className="h-16 px-4 flex items-center justify-between border-b border-border bg-card/50 backdrop-blur-sm">
              <div className="flex items-center gap-3">
                <Button 
                  variant="ghost" 
                  size="icon" 
                  className="lg:hidden h-9 w-9 rounded-full"
                  onClick={() => setSelectedConversation(null)}
                >
                  <ArrowLeft className="h-5 w-5" />
                </Button>
                <div className="relative">
                  <Avatar className="h-10 w-10">
                    <AvatarImage src={otherUser?.avatar_url} />
                    <AvatarFallback className="bg-primary/10 text-primary font-medium">
                      {getConversationName(selectedConv).charAt(0).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  {!selectedConv.is_group && otherUser && isUserOnline(otherUser.user_id) && (
                    <span className="absolute bottom-0 right-0 w-3 h-3 bg-chat-online rounded-full border-2 border-card" />
                  )}
                </div>
                <div>
                  <h2 className="font-semibold text-foreground">{getConversationName(selectedConv)}</h2>
                  {!selectedConv.is_group && otherUser && isUserOnline(otherUser.user_id) && (
                    <p className="text-xs text-chat-online font-medium">Online</p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1">
                <Button 
                  variant="ghost" 
                  size="icon" 
                  onClick={startVideoCall}
                  disabled={!selectedConv.participants?.some(p => p.user_id !== user?.id)}
                  className="h-9 w-9 rounded-full hover:bg-primary/10"
                >
                  <Video className="h-5 w-5 text-primary" />
                </Button>
                <Button variant="ghost" size="icon" className="h-9 w-9 rounded-full hover:bg-muted/50">
                  <MoreVertical className="h-5 w-5 text-muted-foreground" />
                </Button>
              </div>
            </div>

            {/* Messages */}
            <ScrollArea className="flex-1 p-4">
              <div className="space-y-4 max-w-3xl mx-auto">
                {messages.map((message, index) => {
                  const isOwn = message.sender_id === user?.id;
                  const showAvatar = index === 0 || messages[index - 1]?.sender_id !== message.sender_id;
                  
                  return (
                    <div key={message.id} className={`flex ${isOwn ? 'justify-end' : 'justify-start'} animate-fade-in`}>
                      <div className={`flex items-end gap-2 max-w-[80%] ${isOwn ? 'flex-row-reverse' : 'flex-row'}`}>
                        {showAvatar ? (
                          <Avatar className="h-8 w-8 flex-shrink-0">
                            <AvatarImage src={message.sender_profile?.avatar_url} />
                            <AvatarFallback className="bg-primary/10 text-primary text-xs font-medium">
                              {message.sender_profile?.display_name?.charAt(0).toUpperCase()}
                            </AvatarFallback>
                          </Avatar>
                        ) : (
                          <div className="w-8 flex-shrink-0" />
                        )}
                        <div className={`group relative px-4 py-2.5 rounded-2xl ${
                          isOwn 
                            ? 'bg-primary text-primary-foreground rounded-br-md' 
                            : 'bg-muted text-foreground rounded-bl-md'
                        }`}>
                          {message.message_type === 'text' && (
                            <p className="text-[15px] leading-relaxed whitespace-pre-wrap break-words">
                              {message.content}
                            </p>
                          )}
                          {message.message_type === 'image' && (
                            <img 
                              src={message.image_url!} 
                              alt="Shared" 
                              className="max-w-xs rounded-xl cursor-pointer hover:opacity-90 transition-opacity" 
                              onClick={() => window.open(message.image_url!, '_blank')} 
                            />
                          )}
                          {message.message_type === 'call_info' && (
                            <div className="flex items-center gap-2 text-sm">
                              <Video className="h-4 w-4" />
                              <span>{message.content}</span>
                            </div>
                          )}
                          <span className={`text-[10px] mt-1 block ${isOwn ? 'text-primary-foreground/70' : 'text-muted-foreground'}`}>
                            {new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
                <div ref={messagesEndRef} />
              </div>
            </ScrollArea>

            {/* Message Input */}
            <div className="p-4 border-t border-border bg-card/50 backdrop-blur-sm">
              <form onSubmit={sendMessage} className="flex items-center gap-3 max-w-3xl mx-auto">
                <input ref={fileInputRef} type="file" accept="image/*" onChange={uploadImage} className="hidden" />
                <Button 
                  type="button" 
                  size="icon" 
                  variant="ghost"
                  onClick={() => fileInputRef.current?.click()} 
                  disabled={isLoading}
                  className="h-10 w-10 rounded-full hover:bg-muted flex-shrink-0"
                >
                  <Image className="h-5 w-5 text-muted-foreground" />
                </Button>
                <div className="flex-1 relative">
                  <Input 
                    value={newMessage} 
                    onChange={(e) => setNewMessage(e.target.value)} 
                    placeholder="Type a message..." 
                    disabled={isLoading}
                    className="w-full bg-muted border-0 rounded-full py-5 px-5 focus-visible:ring-1 focus-visible:ring-primary placeholder:text-muted-foreground/60"
                  />
                </div>
                <Button 
                  type="submit" 
                  size="icon"
                  disabled={isLoading || !newMessage.trim()}
                  className="h-10 w-10 rounded-full bg-primary hover:bg-primary/90 flex-shrink-0"
                >
                  <Send className="h-5 w-5" />
                </Button>
              </form>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center px-4">
              <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-primary/10 flex items-center justify-center">
                <MessageCircle className="h-10 w-10 text-primary" />
              </div>
              <h3 className="text-xl font-semibold text-foreground mb-2">Select a conversation</h3>
              <p className="text-muted-foreground">Choose from your existing conversations or start a new one</p>
            </div>
          </div>
        )}
      </div>

      {/* Incoming Call Dialog */}
      <Dialog open={!!incomingCall} onOpenChange={() => setIncomingCall(null)}>
        <DialogContent className="sm:max-w-sm bg-card border-border">
          <div className="flex flex-col items-center py-6 space-y-6">
            <div className="relative">
              <Avatar className="h-24 w-24 animate-pulse-soft">
                <AvatarImage src={incomingCall?.caller?.avatar_url} />
                <AvatarFallback className="bg-primary/10 text-primary text-2xl font-semibold">
                  {incomingCall?.caller?.display_name?.charAt(0).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <span className="absolute inset-0 rounded-full border-4 border-primary/30 animate-ping" />
            </div>
            <div className="text-center">
              <p className="text-xl font-semibold text-foreground">{incomingCall?.caller?.display_name}</p>
              <p className="text-muted-foreground mt-1">Incoming video call...</p>
            </div>
          </div>
          <DialogFooter className="flex gap-3 sm:justify-center">
            <Button 
              variant="destructive" 
              size="lg"
              onClick={declineCall}
              className="flex-1 rounded-full h-12"
            >
              <PhoneOff className="mr-2 h-5 w-5" />
              Decline
            </Button>
            <Button 
              size="lg"
              onClick={acceptCall}
              className="flex-1 rounded-full h-12 bg-chat-online hover:bg-chat-online/90"
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
