"use client";

import {Toaster as SonnerToaster} from "sonner";

function Toaster() {
    return (
        <SonnerToaster
      theme="dark"
            position="top-right"
            mobileOffset={{top: "64px", right: "16px", left: "16px", bottom: "16px"}}
            closeButton
            richColors
            toastOptions={{
                className: "text-sm",
            }}
        />
    );
}

export {Toaster};
