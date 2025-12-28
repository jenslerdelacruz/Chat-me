import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { Send, Image, User, Plus, Settings, LogOut, UserPlus, ArrowLeft, Video, MessageCircle, Phone, PhoneOff, Check, CheckCheck, Smile, Edit2, Trash2, X } from 'lucide-react';
import { VideoCall } from '@/components/VideoCall';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { usePushNotifications } from '@/hooks/usePushNotifications';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';

// Simple toast mock function (replace with actual useToast later)
const useToast = () => ({
  toast: (options: any) => console.log('Toast:', options),
});

// ----- Interfaces -----
interface Message {
  id: string;
  content: string | null;
  image_url?: string | null;
  message_type: 'text' | 'image' | 'call_info';
  created_at: string;
  sender_id: string;
  conversation_id: string;
  reactions?: { emoji: string; user_id: string }[];
  seen_by?: string[];
  sender_profile?: {
    display_name: string;
    avatar_url?: string;
  };
}

const REACTION_EMOJIS = ['❤️', '😂', '😮', '😢', '😡', '👍'];

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

// ----- Interface para sa Incoming Call -----
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
  const { sendNotification, requestPermission } = usePushNotifications();
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
  
  // ----- State para sa Incoming Call -----
  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null);
  const [userProfile, setUserProfile] = useState<Profile | null>(null);
  const [callEndChannel, setCallEndChannel] = useState<any>(null);
  
  // ----- Typing indicator state -----
  const [typingUsers, setTypingUsers] = useState<Map<string, { user_id: string; display_name: string }>>(new Map());
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const typingChannelRef = useRef<any>(null);
  
  // ----- Message editing/deletion state -----
  const [editingMessage, setEditingMessage] = useState<Message | null>(null);
  const [editContent, setEditContent] = useState('');
  const [messageToDelete, setMessageToDelete] = useState<Message | null>(null);

  useEffect(() => {
    if (user) {
      fetchUserProfile();
      fetchConversations();
      updateUserPresence();
      subscribeToPresence();
      subscribeToCalls();
      requestPermission(); // Request notification permission on load
    }
  }, [user]);

  useEffect(() => {
    if (selectedConversation) {
      fetchMessages();
      const subscription = subscribeToMessages();
      subscribeToTyping();
      markMessagesAsSeen();
      return () => {
        subscription.unsubscribe();
        if (typingChannelRef.current) {
          supabase.removeChannel(typingChannelRef.current);
        }
      };
    }
  }, [selectedConversation]);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);
  
  const fetchUserProfile = async () => {
    if (!user) return;
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('user_id', user.id)
        .single();
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
      await supabase
        .from('profiles')
        .update({ last_seen: new Date().toISOString() })
        .eq('user_id', user.id);
    } catch (error) {
      console.error('Error updating presence:', error);
    }
  };

  const subscribeToPresence = () => {
    const channel = supabase.channel('presence');
    channel
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, () => {
        fetchOnlineUsers();
      })
      .subscribe();
    fetchOnlineUsers();
    return () => {
      supabase.removeChannel(channel);
    };
  };

  const subscribeToCalls = () => {
    if (!user) return () => {};
    const channel = supabase.channel(`calls-${user.id}`);
    channel
      .on('broadcast', { event: 'incoming_call' }, ({ payload }) => {
        console.log('Incoming call received:', payload);
        if (payload.caller.user_id !== user.id) {
          setIncomingCall(payload);
          // Auto dismiss after 30 seconds if not answered
          setTimeout(() => {
            setIncomingCall(prev => {
              if (prev && prev.callId === payload.callId) {
                toast({
                  title: "📞 Missed Call",
                  description: `You missed a call from ${payload.caller.display_name}`,
                  variant: "default"
                });
                return null;
              }
              return prev;
            });
          }, 30000);
        }
      })
      .on('broadcast', { event: 'call_ended' }, ({ payload }) => {
        console.log('Call ended signal received:', payload);
        setIncomingCall(null);
        setShowVideoCall(false);
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  };


  const fetchOnlineUsers = async () => {
    try {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const { data } = await supabase
        .from('profiles')
        .select('user_id')
        .gte('last_seen', fiveMinutesAgo);
      setOnlineUsers(new Set(data?.map(p => p.user_id) || []));
    } catch (error) {
      console.error('Error fetching online users:', error);
    }
  };
  
  const fetchConversations = async () => {
    try {
      const { data, error } = await supabase
        .from('conversation_participants')
        .select(`
          conversation_id,
          conversations!inner ( id, name, is_group, created_at )
        `)
        .eq('user_id', user?.id);
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
      const messagesWithProfiles = messagesData?.map(message => ({ 
        ...message, 
        message_type: message.message_type as 'text' | 'image' | 'call_info', 
        reactions: (message.reactions as { emoji: string; user_id: string }[] | null) || [],
        seen_by: (message.seen_by as string[] | null) || [],
        sender_profile: profilesData?.find(p => p.user_id === message.sender_id) 
      })) || [];
      setMessages(messagesWithProfiles as Message[]);
    } catch (error: any) {
      console.error("Error loading messages:", error.message);
    }
  };
  
  // ----- Typing indicator functions -----
  const subscribeToTyping = () => {
    if (!selectedConversation || !user || !userProfile) return;
    
    typingChannelRef.current = supabase.channel(`typing-${selectedConversation}`);
    
    typingChannelRef.current
      .on('broadcast', { event: 'typing' }, ({ payload }: { payload: { user_id: string; display_name: string; is_typing: boolean } }) => {
        if (payload.user_id !== user.id) {
          setTypingUsers(prev => {
            const newMap = new Map(prev);
            if (payload.is_typing) {
              newMap.set(payload.user_id, { user_id: payload.user_id, display_name: payload.display_name });
            } else {
              newMap.delete(payload.user_id);
            }
            return newMap;
          });
        }
      })
      .subscribe();
  };

  const sendTypingIndicator = useCallback((isTyping: boolean) => {
    if (!selectedConversation || !user || !userProfile) return;
    
    const channel = supabase.channel(`typing-${selectedConversation}`);
    channel.send({
      type: 'broadcast',
      event: 'typing',
      payload: { user_id: user.id, display_name: userProfile.display_name, is_typing: isTyping }
    });
  }, [selectedConversation, user, userProfile]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setNewMessage(e.target.value);
    
    // Send typing indicator
    sendTypingIndicator(true);
    
    // Clear previous timeout
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }
    
    // Set timeout to stop typing indicator after 2 seconds of no typing
    typingTimeoutRef.current = setTimeout(() => {
      sendTypingIndicator(false);
    }, 2000);
  };

  // ----- Mark messages as seen -----
  const markMessagesAsSeen = async () => {
    if (!selectedConversation || !user) return;
    
    try {
      // Get unread messages not sent by current user
      const { data: unreadMessages } = await supabase
        .from('messages')
        .select('id, seen_by')
        .eq('conversation_id', selectedConversation)
        .neq('sender_id', user.id);
      
      if (!unreadMessages) return;
      
      // Update each message to include current user in seen_by
      for (const msg of unreadMessages) {
        const currentSeenBy = (msg.seen_by as string[] | null) || [];
        if (!currentSeenBy.includes(user.id)) {
          await supabase
            .from('messages')
            .update({ seen_by: [...currentSeenBy, user.id] })
            .eq('id', msg.id);
        }
      }
    } catch (error) {
      console.error('Error marking messages as seen:', error);
    }
  };

  // ----- Message reactions -----
  const addReaction = async (messageId: string, emoji: string) => {
    if (!user) return;
    
    try {
      const message = messages.find(m => m.id === messageId);
      if (!message) return;
      
      const currentReactions = message.reactions || [];
      const existingReactionIndex = currentReactions.findIndex(
        r => r.user_id === user.id && r.emoji === emoji
      );
      
      let newReactions;
      if (existingReactionIndex > -1) {
        // Remove reaction if already exists
        newReactions = currentReactions.filter((_, i) => i !== existingReactionIndex);
      } else {
        // Add new reaction
        newReactions = [...currentReactions, { emoji, user_id: user.id }];
      }
      
      const { error } = await supabase
        .from('messages')
        .update({ reactions: newReactions })
        .eq('id', messageId);
      
      if (error) throw error;
      
      // Update local state
      setMessages(prev => prev.map(m => 
        m.id === messageId ? { ...m, reactions: newReactions } : m
      ));
    } catch (error) {
      console.error('Error adding reaction:', error);
    }
  };

  const subscribeToMessages = () => {
    return supabase
      .channel(`messages-${selectedConversation}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${selectedConversation}`},
        async (payload) => {
          const newMessagePayload = payload.new as any;
          const { data: profileData } = await supabase.from('profiles').select('user_id, display_name, avatar_url').eq('user_id', newMessagePayload.sender_id).maybeSingle();
          const messageWithProfile: Message = { 
            ...newMessagePayload, 
            message_type: newMessagePayload.message_type as 'text' | 'image' | 'call_info',
            reactions: newMessagePayload.reactions || [],
            seen_by: newMessagePayload.seen_by || [],
            sender_profile: profileData 
          };
          setMessages(prevMessages => {
            const exists = prevMessages.some(msg => msg.id === messageWithProfile.id);
            if (exists) return prevMessages;
            return [...prevMessages, messageWithProfile];
          });
          
          // Send push notification for new messages from others
          if (newMessagePayload.sender_id !== user?.id && profileData) {
            sendNotification(`New message from ${profileData.display_name}`, {
              body: newMessagePayload.content || 'Sent an image',
              tag: `message-${newMessagePayload.id}`
            });
          }
        }
      )
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages', filter: `conversation_id=eq.${selectedConversation}`},
        async (payload) => {
          const updatedMessage = payload.new as any;
          setMessages(prevMessages => 
            prevMessages.map(msg => 
              msg.id === updatedMessage.id 
                ? { 
                    ...msg, 
                    content: updatedMessage.content,
                    reactions: updatedMessage.reactions || [],
                    seen_by: updatedMessage.seen_by || []
                  } 
                : msg
            )
          );
        }
      )
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages', filter: `conversation_id=eq.${selectedConversation}`},
        async (payload) => {
          const deletedMessage = payload.old as any;
          setMessages(prevMessages => prevMessages.filter(msg => msg.id !== deletedMessage.id));
        }
      )
      .subscribe();
  };
  
  // ----- Message editing -----
  const startEditMessage = (message: Message) => {
    setEditingMessage(message);
    setEditContent(message.content || '');
  };
  
  const cancelEdit = () => {
    setEditingMessage(null);
    setEditContent('');
  };
  
  const saveEditMessage = async () => {
    if (!editingMessage || !editContent.trim()) return;
    
    try {
      const { error } = await supabase
        .from('messages')
        .update({ content: editContent.trim() })
        .eq('id', editingMessage.id);
      
      if (error) throw error;
      
      setMessages(prev => prev.map(msg => 
        msg.id === editingMessage.id ? { ...msg, content: editContent.trim() } : msg
      ));
      cancelEdit();
    } catch (error) {
      console.error('Error editing message:', error);
    }
  };
  
  // ----- Message deletion -----
  const confirmDeleteMessage = async () => {
    if (!messageToDelete) return;
    
    try {
      const { error } = await supabase
        .from('messages')
        .delete()
        .eq('id', messageToDelete.id);
      
      if (error) throw error;
      
      setMessages(prev => prev.filter(msg => msg.id !== messageToDelete.id));
      setMessageToDelete(null);
    } catch (error) {
      console.error('Error deleting message:', error);
    }
  };
  
  const sendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMessage.trim() || !selectedConversation || !user) return;
    setIsLoading(true);
    
    // Stop typing indicator
    sendTypingIndicator(false);
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }
    
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
      console.error("File too large: Please select an image smaller than 10MB.");
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
    // Sanitize input to prevent ILIKE pattern injection
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
    if(!user) return;
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
    
    // Send call to all participants
    for (const participant of otherParticipants) {
      const channel = supabase.channel(`calls-${participant.user_id}`);
      await channel.send({ 
        type: 'broadcast', 
        event: 'incoming_call', 
        payload: { 
          roomUrl: jitsiRoomUrl, 
          caller: userProfile, 
          conversationId: selectedConversation,
          callId: callId
        } 
      });
    }
    await supabase.from('messages').insert({ conversation_id: selectedConversation, sender_id: user.id, content: `Started a video call.`, message_type: 'call_info'});
  };

  const acceptCall = () => {
    if (incomingCall) {
      setVideoCallUrl(incomingCall.roomUrl);
      setSelectedConversation(incomingCall.conversationId);
      setShowVideoCall(true);
      setIncomingCall(null);
    }
  };

  const declineCall = () => {
    setIncomingCall(null);
  };

  const endCall = async () => {
    if (!selectedConversation || !user) return;
    
    const currentConv = getCurrentConversation();
    const otherParticipants = currentConv?.participants?.filter(p => p.user_id !== user.id);
    
    // Send end call signal to all participants
    for (const participant of otherParticipants || []) {
      const channel = supabase.channel(`calls-${participant.user_id}`);
      await channel.send({ 
        type: 'broadcast', 
        event: 'call_ended', 
        payload: { 
          callerId: user.id,
          conversationId: selectedConversation
        } 
      });
    }
    
    setShowVideoCall(false);
    setVideoCallUrl('');
    setIncomingCall(null);
  };

  const selectedConv = getCurrentConversation();

  return (
    <div className="h-screen flex flex-col bg-white overflow-hidden">
      {/* Mobile Header */}
      <div className="lg:hidden border-b border-gray-200 bg-white backdrop-blur-sm p-4 flex items-center justify-between shadow-sm">
        {selectedConversation && selectedConv ? (
          <>
            <div className="flex items-center space-x-3">
              <Button variant="ghost" size="sm" onClick={() => setSelectedConversation(null)} className="p-2 hover:bg-gray-100 hover:scale-110 transition-all duration-300">
                <ArrowLeft className="h-5 w-5 text-gray-700" />
              </Button>
              <div className="flex items-center space-x-3">
                <div className="relative">
                  <Avatar className="h-10 w-10 border-2 border-gray-200 shadow-sm">
                    <AvatarImage src={selectedConv?.participants?.find(p => p.user_id !== user?.id)?.avatar_url} />
                    <AvatarFallback className="bg-gray-100 text-gray-600 font-semibold">
                      <User className="h-5 w-5" />
                    </AvatarFallback>
                  </Avatar>
                  {!selectedConv.is_group && selectedConv.participants?.some(p => p.user_id !== user?.id && isUserOnline(p.user_id)) && (
                    <div className="absolute -top-1 -right-1 w-3 h-3 bg-green-500 rounded-full border-2 border-white animate-pulse" />
                  )}
                </div>
                <div>
                  <h2 className="font-semibold text-gray-900">{getConversationName(selectedConv)}</h2>
                  {!selectedConv.is_group && selectedConv.participants?.some(p => p.user_id !== user?.id && isUserOnline(p.user_id)) && (
                    <p className="text-xs text-green-600 font-medium flex items-center gap-1">
                      <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" /> Online
                    </p>
                  )}
                </div>
              </div>
            </div>
            <div className="flex space-x-2">
              <Button variant="ghost" size="sm" onClick={startVideoCall} disabled={!selectedConv.participants?.some(p => p.user_id !== user?.id)} className="hover:bg-gray-100 hover:scale-110 transition-all duration-300 text-gray-700">
                <Video className="h-5 w-5" />
              </Button>
              <Button variant="ghost" size="sm" onClick={() => navigate('/dashboard')} className="hover:bg-gray-100 hover:scale-110 transition-all duration-300 text-gray-700">
                <Settings className="h-5 w-5" />
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-blue-600 rounded-lg flex items-center justify-center"> <span className="text-white font-bold text-sm">C</span> </div>
              <h1 className="text-xl font-bold text-gray-900">Messages</h1>
            </div>
            <div className="flex items-center space-x-2">
              <Button variant="ghost" size="sm" onClick={() => navigate('/dashboard')} className="hover:bg-gray-100 hover:scale-110 transition-all duration-300 text-gray-700">
                <Settings className="h-5 w-5" />
              </Button>
              <Button variant="ghost" size="sm" onClick={handleSignOut} className="hover:bg-gray-100 hover:scale-110 transition-all duration-300 text-gray-700">
                <LogOut className="h-5 w-5" />
              </Button>
            </div>
          </>
        )}
      </div>

      {/* Desktop Header */}
      <div className="hidden lg:block border-b border-gray-200 bg-white backdrop-blur-sm p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-blue-600 rounded-xl flex items-center justify-center shadow-sm"><span className="text-white font-bold text-lg">C</span></div>
            <h1 className="text-2xl font-bold text-gray-900">Messages</h1>
          </div>
          <div className="flex items-center space-x-3">
            <Button variant="ghost" size="sm" onClick={() => navigate('/dashboard')} className="hover:bg-gray-100 hover:scale-110 transition-all duration-300 text-gray-700">
              <Settings className="h-5 w-5 mr-2" /> Profile
            </Button>
            <Button variant="ghost" size="sm" onClick={handleSignOut} className="hover:bg-gray-100 hover:scale-110 transition-all duration-300 text-gray-700">
              <LogOut className="h-5 w-5 mr-2" /> Sign Out
            </Button>
          </div>
        </div>
      </div>

      <div className="flex-1 flex bg-gray-50 overflow-hidden">
        {/* Sidebar */}
        <div className={`lg:w-80 lg:block border-r border-gray-200 bg-white backdrop-blur-sm ${selectedConversation ? 'hidden lg:block' : 'w-full block'}`}>
          <div className="p-6 border-b border-gray-200 bg-white">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-bold text-gray-900">Conversations</h2>
              <Dialog open={showAddUser} onOpenChange={setShowAddUser}>
                <DialogTrigger asChild>
                  <Button size="sm" variant="outline" className="border-gray-300 hover:bg-gray-50 hover:scale-110 transition-all duration-300">
                    <UserPlus className="h-4 w-4 text-gray-700" />
                  </Button>
                </DialogTrigger>
                <DialogContent className="mx-4 bg-white border-gray-200">
                  <DialogHeader>
                    <DialogTitle className="text-xl font-bold text-gray-900">Start a chat with someone</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-4">
                    <Input placeholder="Search users..." value={searchUsers} onChange={(e) => { setSearchUsers(e.target.value); searchForUsers(e.target.value); }} className="border-gray-300 focus:border-blue-500 focus:ring-blue-50" />
                    <ScrollArea className="h-60">
                      <div className="space-y-2">
                        {foundUsers.map((profile) => (
                          <div key={profile.id} className="cursor-pointer hover:bg-gray-50 hover:scale-105 transition-all duration-300 border-gray-200 bg-white p-4 rounded-lg" onClick={() => createConversationWithUser(profile)}>
                            <div className="flex items-center space-x-3">
                              <div className="relative">
                                <Avatar className="h-10 w-10 border-2 border-gray-200 shadow-sm">
                                  <AvatarImage src={profile.avatar_url} />
                                  <AvatarFallback className="bg-gray-100 text-gray-600 font-semibold"><User className="h-5 w-5" /></AvatarFallback>
                                </Avatar>
                                {isUserOnline(profile.user_id) && <div className="absolute -top-1 -right-1 w-3 h-3 bg-green-500 rounded-full border-2 border-white animate-pulse" />}
                              </div>
                              <div className="flex-1">
                                <div className="flex items-center space-x-2">
                                  <p className="font-semibold text-gray-900">{profile.display_name}</p>
                                  {isUserOnline(profile.user_id) && <Badge variant="secondary" className="text-xs bg-green-100 text-green-800 border border-green-200">Online</Badge>}
                                </div>
                                <p className="text-sm text-gray-500">@{profile.username}</p>
                              </div>
                            </div>
                          </div>
                        ))}
                        {searchUsers && foundUsers.length === 0 && (
                          <div className="text-center py-8">
                            <User className="h-12 w-12 mx-auto text-gray-400 mb-3" />
                            <p className="text-gray-500 font-medium">No users found</p>
                            <p className="text-sm text-gray-400">Try searching with a different term</p>
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
                  <div key={conversation.id} className={`cursor-pointer transition-all duration-300 hover:scale-105 border-gray-200 ${selectedConversation === conversation.id ? 'bg-blue-50 border-blue-300 shadow-sm' : 'hover:bg-gray-50 hover:border-gray-300 bg-white'} p-4 rounded-lg`} onClick={() => setSelectedConversation(conversation.id)}>
                    <div className="flex items-center space-x-3">
                      <div className="relative">
                        <Avatar className="h-12 w-12 border-2 border-gray-200 shadow-sm">
                          <AvatarImage src={otherParticipant?.avatar_url} />
                          <AvatarFallback className="bg-gray-100 text-gray-600 font-semibold"><User className="h-6 w-6" /></AvatarFallback>
                        </Avatar>
                        {!conversation.is_group && isOnline && <div className="absolute -top-1 -right-1 w-4 h-4 bg-green-500 rounded-full border-2 border-white animate-pulse" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between">
                          <h3 className="font-semibold truncate text-gray-900 text-base">{getConversationName(conversation)}</h3>
                          {!conversation.is_group && isOnline && <Badge variant="secondary" className="text-xs bg-green-100 text-green-800 border border-green-200 ml-2">Online</Badge>}
                        </div>
                        <p className="text-sm text-gray-500">{conversation.is_group ? '👥 Group Chat' : '💬 Direct Message'}</p>
                      </div>
                    </div>
                  </div>
                );
              })}
              {conversations.length === 0 && (
                <div className="text-center py-12">
                  <MessageCircle className="h-16 w-16 mx-auto text-gray-400 mb-4 opacity-50" />
                  <p className="text-gray-500 font-medium mb-2">No conversations yet</p>
                  <p className="text-sm text-gray-400">Start chatting by adding a new contact</p>
                </div>
              )}
            </div>
          </ScrollArea>
        </div>
        <div className={`flex-1 flex flex-col bg-white ${!selectedConversation ? 'hidden lg:flex' : 'flex'}`}>
          {selectedConversation && selectedConv ? (
            <>
              <div className="hidden lg:block border-b border-gray-200 p-6 bg-white">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-4">
                    <div className="relative">
                      <Avatar className="h-12 w-12 border-2 border-gray-200 shadow-sm">
                        <AvatarImage src={selectedConv.participants?.find(p => p.user_id !== user?.id)?.avatar_url} />
                        <AvatarFallback className="bg-gray-100 text-gray-600 font-semibold"><User className="h-6 w-6" /></AvatarFallback>
                      </Avatar>
                      {!selectedConv.is_group && selectedConv.participants?.some(p => p.user_id !== user?.id && isUserOnline(p.user_id)) && <div className="absolute -top-1 -right-1 w-4 h-4 bg-green-500 rounded-full border-2 border-white animate-pulse" />}
                    </div>
                    <div>
                      <h2 className="font-semibold text-lg text-gray-900">{getConversationName(selectedConv)}</h2>
                      {!selectedConv.is_group && selectedConv.participants?.some(p => p.user_id !== user?.id && isUserOnline(p.user_id)) && <p className="text-sm text-green-600 font-medium flex items-center gap-2"><div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />Online</p>}
                    </div>
                  </div>
                  <Button variant="outline" size="sm" onClick={startVideoCall} disabled={!selectedConv.participants?.some(p => p.user_id !== user?.id)} className="border-gray-300 hover:bg-gray-50 hover:scale-110 transition-all duration-300 text-gray-700">
                    <Video className="h-4 w-4 mr-2" />Video Call
                  </Button>
                </div>
              </div>
              <ScrollArea className="flex-1 p-4 bg-white">
                <div className="space-y-4">
                  {messages.map((message, index) => {
                    const isOwnMessage = message.sender_id === user?.id;
                    const isLastOwnMessage = isOwnMessage && messages.filter(m => m.sender_id === user?.id).pop()?.id === message.id;
                    const seenByOthers = message.seen_by?.filter(id => id !== user?.id) || [];
                    const hasReactions = message.reactions && message.reactions.length > 0;
                    
                    return (
                      <div key={message.id} className={`flex ${isOwnMessage ? 'justify-end' : 'justify-start'} animate-fade-in`}>
                        <div className={`flex max-w-[85%] sm:max-w-[70%] ${isOwnMessage ? 'flex-row-reverse' : 'flex-row'} group`}>
                          <Avatar className="h-11 w-11 mx-3 flex-shrink-0 border-3 border-gray-200 shadow-sm hover:scale-110 transition-all duration-300">
                            <AvatarImage src={message.sender_profile?.avatar_url} />
                            <AvatarFallback className="bg-gray-100 text-gray-600 font-bold text-lg"><User className="h-6 w-6" /></AvatarFallback>
                          </Avatar>
                          <div className="flex flex-col">
                            <div className={`relative rounded-2xl p-4 shadow-sm backdrop-blur-sm border-2 hover:scale-[1.02] transition-all duration-300 ${
                              isOwnMessage 
                                ? 'bg-blue-500 text-white border-blue-400 shadow-blue-100' 
                                : 'bg-gray-100 text-gray-900 border-gray-200 shadow-gray-100'
                            }`}>
                              <div className="absolute inset-0 bg-gradient-to-br from-white/10 to-transparent rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                              <div className="relative z-10">
                                <div className="flex items-center justify-between mb-2">
                                  <p className="text-xs font-bold opacity-80 tracking-wider uppercase">{message.sender_profile?.display_name}</p>
                                  <p className="text-xs opacity-60">{new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
                                </div>
                                {message.message_type === 'text' && (
                                  <p className="break-words text-base leading-relaxed font-medium">{message.content}</p>
                                )}
                                {message.message_type === 'image' && (
                                  <div className="relative overflow-hidden rounded-xl shadow-sm">
                                    <img 
                                      src={message.image_url!} 
                                      alt="Shared" 
                                      className="max-w-full max-h-80 h-auto cursor-pointer hover:scale-110 transition-all duration-500 rounded-xl" 
                                      onClick={() => window.open(message.image_url!, '_blank')} 
                                    />
                                    <div className="absolute inset-0 bg-gradient-to-t from-black/20 to-transparent opacity-0 hover:opacity-100 transition-opacity duration-300 rounded-xl" />
                                  </div>
                                )}
                                {message.message_type === 'call_info' && (
                                  <div className="flex items-center justify-center gap-2 p-3 bg-gradient-to-r from-blue-50 to-blue-100 rounded-xl border border-blue-200">
                                    <Video className="h-4 w-4 text-blue-600" />
                                    <p className="text-sm font-semibold text-center text-blue-900">{message.content}</p>
                                  </div>
                                )}
                              </div>
                              
                              {/* Reaction button */}
                              <Popover>
                                <PopoverTrigger asChild>
                                  <button className={`absolute -bottom-2 ${isOwnMessage ? '-left-2' : '-right-2'} opacity-0 group-hover:opacity-100 transition-opacity bg-white border border-gray-200 rounded-full p-1.5 shadow-md hover:scale-110`}>
                                    <Smile className="h-4 w-4 text-gray-500" />
                                  </button>
                                </PopoverTrigger>
                                <PopoverContent className="w-auto p-2 bg-white border border-gray-200 shadow-lg rounded-full">
                                  <div className="flex gap-1">
                                    {REACTION_EMOJIS.map(emoji => (
                                      <button 
                                        key={emoji} 
                                        onClick={() => addReaction(message.id, emoji)}
                                        className="hover:scale-125 transition-transform p-1 text-lg"
                                      >
                                        {emoji}
                                      </button>
                                    ))}
                                  </div>
                                </PopoverContent>
                              </Popover>
                            </div>
                            
                            {/* Reactions display */}
                            {hasReactions && (
                              <div className={`flex flex-wrap gap-1 mt-1 ${isOwnMessage ? 'justify-end' : 'justify-start'}`}>
                                {Object.entries(
                                  message.reactions!.reduce((acc, r) => {
                                    acc[r.emoji] = (acc[r.emoji] || 0) + 1;
                                    return acc;
                                  }, {} as Record<string, number>)
                                ).map(([emoji, count]) => (
                                  <button 
                                    key={emoji}
                                    onClick={() => addReaction(message.id, emoji)}
                                    className="bg-white border border-gray-200 rounded-full px-2 py-0.5 text-sm shadow-sm hover:scale-105 transition-transform flex items-center gap-1"
                                  >
                                    <span>{emoji}</span>
                                    <span className="text-xs text-gray-600">{count}</span>
                                  </button>
                                ))}
                              </div>
                            )}
                            
                            {/* Seen status for own messages */}
                            {isOwnMessage && isLastOwnMessage && (
                              <div className={`flex items-center gap-1 mt-1 ${isOwnMessage ? 'justify-end' : 'justify-start'}`}>
                                {seenByOthers.length > 0 ? (
                                  <span className="flex items-center gap-1 text-xs text-blue-500">
                                    <CheckCheck className="h-4 w-4" />
                                    Seen
                                  </span>
                                ) : (
                                  <span className="flex items-center gap-1 text-xs text-gray-400">
                                    <Check className="h-4 w-4" />
                                    Sent
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  
                  {/* Typing indicator */}
                  {typingUsers.size > 0 && (
                    <div className="flex justify-start animate-fade-in">
                      <div className="flex items-center gap-2 bg-gray-100 rounded-2xl px-4 py-3 border-2 border-gray-200">
                        <div className="flex gap-1">
                          <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                          <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                          <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                        </div>
                        <span className="text-sm text-gray-500">
                          {Array.from(typingUsers.values()).map(u => u.display_name).join(', ')} is typing...
                        </span>
                      </div>
                    </div>
                  )}
                  
                  <div ref={messagesEndRef} />
                </div>
              </ScrollArea>
              <div className="p-4 border-t border-gray-200 bg-white">
                <form onSubmit={sendMessage} className="flex items-center space-x-3">
                  <div className="flex-1 relative">
                    <Input 
                      value={newMessage} 
                      onChange={handleInputChange} 
                      placeholder="Type your message..." 
                      disabled={isLoading} 
                      className="w-full border border-gray-300 focus:border-blue-500 focus:ring-4 focus:ring-blue-50 rounded-full py-3 px-5 text-base bg-white shadow-sm hover:shadow-md transition-all duration-300 font-medium placeholder:text-gray-400" 
                    />
                    <div className="absolute inset-0 rounded-full bg-gradient-to-r from-blue-50 to-blue-100 pointer-events-none opacity-0 hover:opacity-100 transition-opacity duration-300" />
                  </div>
                  <input ref={fileInputRef} type="file" accept="image/*" onChange={uploadImage} className="hidden" />
                  <Button 
                    type="button" 
                    size="icon" 
                    variant="outline" 
                    onClick={() => fileInputRef.current?.click()} 
                    disabled={isLoading} 
                    className="border border-gray-300 hover:bg-gray-50 hover:scale-110 transition-all duration-300 text-gray-700 rounded-full h-12 w-12 shadow-sm hover:shadow-md"
                  >
                    <Image className="h-5 w-5" />
                  </Button>
                  <Button 
                    type="submit" 
                    disabled={isLoading || !newMessage.trim()} 
                    className="bg-blue-500 hover:bg-blue-600 text-white rounded-full px-6 py-3 hover:scale-110 transition-all duration-300 shadow-sm hover:shadow-md font-semibold h-12 disabled:opacity-50 disabled:cursor-not-allowed"
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
                <MessageCircle className="h-24 w-24 mx-auto text-gray-400" />
                <h3 className="text-2xl font-bold text-gray-900">Select a conversation</h3>
                <p className="text-gray-500 text-lg">Choose a conversation to start chatting</p>
              </div>
            </div>
          )}
        </div>
      </div>
      
      {/* Incoming Call Dialog */}
      <Dialog open={!!incomingCall} onOpenChange={() => setIncomingCall(null)}>
        <DialogContent className="w-[95vw] max-w-md mx-auto bg-white border-2 border-gray-200 shadow-lg backdrop-blur-xl rounded-2xl">
          <DialogHeader className="text-center pb-4">
            <DialogTitle className="text-xl md:text-2xl font-bold text-gray-900">📞 Incoming Call</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col items-center justify-center p-4 md:p-6 space-y-4 md:space-y-6">
            <div className="relative">
              <Avatar className="h-20 w-20 md:h-24 md:w-24 border-4 border-gray-200 shadow-lg animate-pulse">
                <AvatarImage src={incomingCall?.caller?.avatar_url} />
                <AvatarFallback className="bg-gray-100 text-gray-600">
                  <User className="h-10 w-10 md:h-12 md:w-12" />
                </AvatarFallback>
              </Avatar>
              <div className="absolute inset-0 rounded-full border-4 border-blue-200 animate-ping" />
            </div>
            <div className="text-center space-y-2">
              <p className="text-lg md:text-xl font-semibold text-gray-900">{incomingCall?.caller?.display_name || 'Someone'}</p>
              <p className="text-sm text-gray-500">is calling you...</p>
            </div>
            <div className="w-full flex justify-center">
              <div className="flex space-x-1">
                <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce [animation-delay:-0.3s]" />
                <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce [animation-delay:-0.15s]" />
                <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce" />
              </div>
            </div>
          </div>
          <DialogFooter className="flex flex-row justify-center gap-3 md:gap-4 pt-4">
            <Button 
              variant="destructive" 
              size="lg" 
              onClick={declineCall}
              className="flex-1 md:flex-none bg-red-500 hover:bg-red-600 rounded-full h-12 md:h-14 font-semibold shadow-sm hover:shadow-md hover:scale-105 transition-all duration-300"
            >
              <PhoneOff className="mr-2 h-4 w-4 md:h-5 md:w-5" />
              <span className="text-sm md:text-base">Decline</span>
            </Button>
            <Button 
              variant="default" 
              size="lg" 
              onClick={acceptCall} 
              className="flex-1 md:flex-none bg-green-500 hover:bg-green-600 rounded-full h-12 md:h-14 font-semibold shadow-sm hover:shadow-md hover:scale-105 transition-all duration-300"
            >
              <Phone className="mr-2 h-4 w-4 md:h-5 md:w-5" />
              <span className="text-sm md:text-base">Accept</span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      
      {/* VideoCall Component */}
      <VideoCall
        isOpen={showVideoCall}
        onClose={endCall}
        roomUrl={videoCallUrl}
      />
    </div>
  );
};

export default Chat;