import {createContext,useContext,useEffect,useMemo,useState} from 'react';
import {api,onUnauthorized} from '../services/api';
const C=createContext<{isAuthenticated:boolean;login:(u:string,p:string)=>Promise<void>;logout:()=>Promise<void>}>({isAuthenticated:false,login:async()=>{},logout:async()=>{}});
export function AuthProvider({children}:{children:React.ReactNode}){const [authenticated,setAuthenticated]=useState(()=>Boolean(sessionStorage.getItem('nm_token')));useEffect(()=>onUnauthorized(()=>{sessionStorage.removeItem('nm_token');setAuthenticated(false);}),[]);const value=useMemo(()=>({isAuthenticated:authenticated,login:async(u:string,p:string)=>{const r=await api.login(u,p);sessionStorage.setItem('nm_token',r.token);setAuthenticated(true);},logout:async()=>{try{await api.logout();}finally{sessionStorage.removeItem('nm_token');setAuthenticated(false);}}}),[authenticated]);return <C.Provider value={value}>{children}</C.Provider>}
export function useAuth(){return useContext(C)}
